package dev.pocket3d.capture

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.hardware.Sensor
import android.hardware.SensorManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.os.Build
import android.os.StatFs
import androidx.core.content.ContextCompat
import com.google.ar.core.ArCoreApk
import com.google.ar.core.Config
import com.google.ar.core.Session
import dev.pocket3d.capture.logic.StorageLevel
import dev.pocket3d.capture.logic.StoragePolicy
import dev.pocket3d.core.services.Services
import dev.pocket3d.core.services.ArRuntimeStatus
import dev.pocket3d.design.Tone
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/** Result of `ArCoreApk.checkAvailability`, reduced to what the UI needs. */
enum class ArCoreAvailability {
    /** Device is certified and Google Play Services for AR is installed and recent enough. */
    SUPPORTED_INSTALLED,
    /** Device is certified but Google Play Services for AR must be installed or updated first. */
    SUPPORTED_NEEDS_INSTALL,
    /** Device is not certified for ARCore. */
    UNSUPPORTED,
    /** The check did not finish (still querying, timed out, or failed). */
    UNKNOWN,
}

/** One back-facing camera as reported by Camera2 (`CameraCharacteristics`). */
data class BackCameraInfo(
    val id: String,
    /** LEGACY | LIMITED | FULL | LEVEL_3 | EXTERNAL | UNKNOWN */
    val hardwareLevel: String,
    /** Largest standard JPEG output size (0 × 0 if the stream map was not readable). */
    val maxJpegWidth: Int,
    val maxJpegHeight: Int,
    val focalLengthsMm: List<Float>,
    val sensorOrientation: Int,
    val manualSensor: Boolean,
    val aeLockAvailable: Boolean,
    /** Autofocus exists and can be held with an AF trigger. False for fixed-focus lenses. */
    val afLockAvailable: Boolean,
    val fixedFocus: Boolean,
    val awbLockAvailable: Boolean,
    /** `LENS_INTRINSIC_CALIBRATION` is reported with a positive focal length. */
    val intrinsicsReported: Boolean,
    /** `LENS_DISTORTION` (API 28+) is reported. */
    val distortionReported: Boolean,
    /** `REQUEST_AVAILABLE_CAPABILITIES_DEPTH_OUTPUT` — a real depth sensor/stream. */
    val depthOutput: Boolean,
)

/** Everything capture-related this device can really do. All values come from platform queries. */
data class DeviceCapabilities(
    val backCameras: List<BackCameraInfo>,
    /** Set when the camera service could not be queried. */
    val cameraQueryError: String?,
    val arCore: ArCoreAvailability,
    /** ARCore Depth API support; null = unknown until an AR session has been opened. */
    val arCoreDepthSupported: Boolean?,
    /** Any back camera advertises a depth output stream. */
    val hardwareDepthCamera: Boolean,
    val rotationVectorSensor: Boolean,
    val gyroscope: Boolean,
    val accelerometer: Boolean,
    /** Free bytes on the volume that stores projects; null if it could not be read. */
    val freeBytes: Long?,
)

object CapabilityProbe {
    /** Last answer of a real ARCore session to `isDepthModeSupported(AUTOMATIC)` in this process. */
    @Volatile private var arDepthSupport: Boolean? = null
    /** True while the capture screen owns an ARCore session (the probe must not open a second one). */
    internal val arSessionActive = AtomicBoolean(false)

    internal fun reportArDepthSupport(supported: Boolean) { arDepthSupport = supported }
    internal val knownArDepthSupport: Boolean? get() = arDepthSupport

    suspend fun probe(context: Context): DeviceCapabilities {
        val app = context.applicationContext
        val (cameras, cameraError) = withContext(Dispatchers.Default) { queryBackCameras(app) }
        val ar = arAvailability(app)
        val depth = arDepthSupport ?: if (ar == ArCoreAvailability.SUPPORTED_INSTALLED) queryArDepth(app) else null
        val sensors = app.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        return DeviceCapabilities(
            backCameras = cameras,
            cameraQueryError = cameraError,
            arCore = ar,
            arCoreDepthSupported = depth,
            hardwareDepthCamera = cameras.any { it.depthOutput },
            rotationVectorSensor = sensors?.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR) != null ||
                sensors?.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR) != null,
            gyroscope = sensors?.getDefaultSensor(Sensor.TYPE_GYROSCOPE) != null,
            accelerometer = sensors?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) != null,
            freeBytes = freeBytes(app),
        )
    }

    /**
     * ARCore availability. `checkAvailability` may answer UNKNOWN_CHECKING while it queries Play
     * Services, so it is polled for up to ~3 s; a result that is still transient is reported as
     * [ArCoreAvailability.UNKNOWN], never guessed.
     */
    suspend fun arAvailability(context: Context): ArCoreAvailability {
        val app = context.applicationContext
        repeat(15) {
            val a = try {
                ArCoreApk.getInstance().checkAvailability(app)
            } catch (t: Throwable) {
                return ArCoreAvailability.UNKNOWN
            }
            when {
                a == ArCoreApk.Availability.SUPPORTED_INSTALLED -> return ArCoreAvailability.SUPPORTED_INSTALLED
                a == ArCoreApk.Availability.SUPPORTED_APK_TOO_OLD || a == ArCoreApk.Availability.SUPPORTED_NOT_INSTALLED ->
                    return ArCoreAvailability.SUPPORTED_NEEDS_INSTALL
                a.isUnsupported -> return ArCoreAvailability.UNSUPPORTED
                !a.isTransient -> return ArCoreAvailability.UNKNOWN
            }
            delay(200)
        }
        return ArCoreAvailability.UNKNOWN
    }

    /**
     * Asks a real (never resumed) ARCore session whether the Depth API is supported. Only possible
     * with the camera permission and while no capture session is open; otherwise the answer stays
     * "unknown until AR is opened".
     */
    private suspend fun queryArDepth(app: Context): Boolean? {
        if (ContextCompat.checkSelfPermission(app, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return null
        if (arSessionActive.get()) return arDepthSupport
        return withContext(Dispatchers.Default) {
            var session: Session? = null
            try {
                session = Session(app)
                session.isDepthModeSupported(Config.DepthMode.AUTOMATIC).also { arDepthSupport = it }
            } catch (t: Throwable) {
                null
            } finally {
                try { session?.close() } catch (_: Throwable) { }
            }
        }
    }

    private fun queryBackCameras(app: Context): Pair<List<BackCameraInfo>, String?> {
        val manager = app.getSystemService(Context.CAMERA_SERVICE) as? CameraManager
            ?: return emptyList<BackCameraInfo>() to "Camera service is not available on this device."
        return try {
            val out = ArrayList<BackCameraInfo>()
            for (id in manager.cameraIdList) {
                val c = try { manager.getCameraCharacteristics(id) } catch (t: Throwable) { continue }
                if (c.get(CameraCharacteristics.LENS_FACING) != CameraMetadata.LENS_FACING_BACK) continue
                out += describe(id, c)
            }
            out to null
        } catch (t: Throwable) {
            emptyList<BackCameraInfo>() to "Cameras could not be queried (${t.javaClass.simpleName})."
        }
    }

    internal fun describe(id: String, c: CameraCharacteristics): BackCameraInfo {
        val caps = c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: IntArray(0)
        val afModes = c.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES) ?: IntArray(0)
        val minFocus = c.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE) ?: 0f
        // Holding focus needs a triggerable autofocus (AF_MODE_AUTO) — the same test the capture engine uses.
        val hasAf = minFocus > 0f && afModes.contains(CameraMetadata.CONTROL_AF_MODE_AUTO)
        val jpeg = try {
            c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)?.getOutputSizes(ImageFormat.JPEG)
                ?.maxByOrNull { it.width.toLong() * it.height }
        } catch (t: Throwable) { null }
        val calib = c.get(CameraCharacteristics.LENS_INTRINSIC_CALIBRATION)
        val distortion = if (Build.VERSION.SDK_INT >= 28) c.get(CameraCharacteristics.LENS_DISTORTION) else null
        return BackCameraInfo(
            id = id,
            hardwareLevel = when (c.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL)) {
                CameraMetadata.INFO_SUPPORTED_HARDWARE_LEVEL_LEGACY -> "LEGACY"
                CameraMetadata.INFO_SUPPORTED_HARDWARE_LEVEL_LIMITED -> "LIMITED"
                CameraMetadata.INFO_SUPPORTED_HARDWARE_LEVEL_FULL -> "FULL"
                CameraMetadata.INFO_SUPPORTED_HARDWARE_LEVEL_3 -> "LEVEL_3"
                CameraMetadata.INFO_SUPPORTED_HARDWARE_LEVEL_EXTERNAL -> "EXTERNAL"
                else -> "UNKNOWN"
            },
            maxJpegWidth = jpeg?.width ?: 0,
            maxJpegHeight = jpeg?.height ?: 0,
            focalLengthsMm = c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.toList().orEmpty(),
            sensorOrientation = c.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0,
            manualSensor = caps.contains(CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR),
            aeLockAvailable = c.get(CameraCharacteristics.CONTROL_AE_LOCK_AVAILABLE) == true,
            afLockAvailable = hasAf,
            fixedFocus = !(minFocus > 0f),
            awbLockAvailable = c.get(CameraCharacteristics.CONTROL_AWB_LOCK_AVAILABLE) == true,
            intrinsicsReported = calib != null && calib.size >= 4 && calib[0] > 0f && calib[1] > 0f,
            distortionReported = distortion != null && distortion.size >= 5,
            depthOutput = caps.contains(CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_DEPTH_OUTPUT),
        )
    }

    internal suspend fun freeBytes(app: Context): Long? {
        try {
            return Services.store.freeBytes()
        } catch (_: UninitializedPropertyAccessException) {
            // Service locator not populated (previews / tests): fall through to the raw volume query.
        } catch (_: Throwable) {
        }
        return withContext(Dispatchers.IO) {
            try { StatFs(app.filesDir.path).availableBytes } catch (t: Throwable) { null }
        }
    }
}

internal fun formatBytes(bytes: Long): String = when {
    bytes >= 1L shl 30 -> String.format(Locale.US, "%.1f GB", bytes / (1L shl 30).toDouble())
    bytes >= 1L shl 20 -> String.format(Locale.US, "%.0f MB", bytes / (1L shl 20).toDouble())
    else -> String.format(Locale.US, "%.0f kB", bytes / 1024.0)
}

/** Rows (feature, status text, tone) for a capability matrix on a settings / diagnostics screen. */
fun DeviceCapabilities.matrixRows(): List<Triple<String, String, Tone>> {
    val rows = ArrayList<Triple<String, String, Tone>>()
    rows += when (arCore) {
        ArCoreAvailability.SUPPORTED_INSTALLED -> when (ArRuntimeStatus.lastSessionOk) {
            // "installed" is what the platform reports; whether a session actually starts is only
            // known after trying.
            false -> Triple("AR motion tracking (ARCore)",
                "Installed, but it failed to start on this device the last time it was tried" +
                    (ArRuntimeStatus.lastFailure?.let { " ($it)" } ?: "") + " — guidance falls back to the orientation estimate",
                Tone.Warn)
            true -> Triple("AR motion tracking (ARCore)", "Supported, installed and started successfully — tracked viewpoints", Tone.Good)
            null -> Triple("AR motion tracking (ARCore)",
                "Reported as supported and installed — not started yet in this session, so not confirmed to work", Tone.Neutral)
        }
        ArCoreAvailability.SUPPORTED_NEEDS_INSTALL ->
            Triple("AR motion tracking (ARCore)", "Supported — Google Play Services for AR must be installed or updated", Tone.Warn)
        ArCoreAvailability.UNSUPPORTED ->
            Triple("AR motion tracking (ARCore)", "Not supported on this device — guidance is estimated from phone orientation", Tone.Neutral)
        ArCoreAvailability.UNKNOWN ->
            Triple("AR motion tracking (ARCore)", "Could not be checked yet — try again", Tone.Neutral)
    }
    rows += Triple("ARCore depth", when (arCoreDepthSupported) {
        true -> "Supported — not used for reconstruction (only to place the object centre while capturing)"
        false -> "Not supported"
        null -> if (arCore == ArCoreAvailability.UNSUPPORTED) "Not available (no ARCore)" else "Unknown until AR capture is opened"
    }, Tone.Neutral)
    val depthCams = backCameras.filter { it.depthOutput }
    rows += Triple("Hardware depth camera",
        if (depthCams.isEmpty()) "None reported by any back camera"
        else "Reported by camera ${depthCams.joinToString { it.id }} — detected, not used for reconstruction in this version",
        Tone.Neutral)

    if (cameraQueryError != null) rows += Triple("Back cameras", cameraQueryError, Tone.Bad)
    else if (backCameras.isEmpty()) rows += Triple("Back cameras", "None found — photos can still be imported", Tone.Warn)
    for (cam in backCameras) {
        val label = "Back camera ${cam.id}"
        val size = if (cam.maxJpegWidth > 0) {
            val mp = cam.maxJpegWidth.toLong() * cam.maxJpegHeight / 1_000_000.0
            String.format(Locale.US, "%d × %d (%.1f MP)", cam.maxJpegWidth, cam.maxJpegHeight, mp)
        } else "JPEG size unknown"
        val focal = if (cam.focalLengthsMm.isEmpty()) "" else
            " · f " + cam.focalLengthsMm.joinToString("/") { String.format(Locale.US, "%.2f", it) } + " mm"
        rows += Triple(label, "$size · ${cam.hardwareLevel}$focal", Tone.Neutral)
        rows += Triple("$label: manual sensor control", if (cam.manualSensor) "Available" else "Not available", Tone.Neutral)
        rows += Triple("$label: exposure lock", if (cam.aeLockAvailable) "Available" else "Not available — exposure may drift between photos",
            if (cam.aeLockAvailable) Tone.Good else Tone.Warn)
        rows += Triple("$label: focus lock", when {
            cam.afLockAvailable -> "Available"
            cam.fixedFocus -> "Fixed-focus lens — focus cannot change"
            else -> "Not available — focus may shift between photos"
        }, if (cam.afLockAvailable) Tone.Good else if (cam.fixedFocus) Tone.Neutral else Tone.Warn)
        rows += Triple("$label: white-balance lock", if (cam.awbLockAvailable) "Available" else "Not available",
            if (cam.awbLockAvailable) Tone.Good else Tone.Warn)
        rows += Triple("$label: lens calibration", when {
            cam.intrinsicsReported && cam.distortionReported -> "Intrinsics and distortion reported by the device"
            cam.intrinsicsReported -> "Intrinsics reported, no distortion"
            else -> "Not reported — focal length comes from EXIF and is refined by the reconstruction"
        }, Tone.Neutral)
    }

    rows += Triple("Rotation vector sensor",
        if (rotationVectorSensor) "Present — used for estimated viewpoint coverage without AR"
        else "Missing — no viewpoint coverage estimate without AR",
        if (rotationVectorSensor) Tone.Good else Tone.Warn)
    rows += Triple("Gyroscope", if (gyroscope) "Present" else "Missing", Tone.Neutral)
    rows += Triple("Accelerometer", if (accelerometer) "Present" else "Missing", Tone.Neutral)
    rows += when (val free = freeBytes) {
        null -> Triple("Free storage", "Could not be read", Tone.Warn)
        else -> when (StoragePolicy.level(free)) {
            StorageLevel.OK -> Triple("Free storage", "${formatBytes(free)} free", Tone.Good)
            StorageLevel.LOW -> Triple("Free storage", "${formatBytes(free)} free — running low", Tone.Warn)
            StorageLevel.BLOCKED -> Triple("Free storage", "${formatBytes(free)} free — too little to capture", Tone.Bad)
        }
    }
    return rows
}
