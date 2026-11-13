package dev.pocket3d.capture.engine

import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.Rect
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.TotalCaptureResult
import android.os.Build
import android.util.Size
import androidx.annotation.OptIn
import androidx.camera.camera2.interop.Camera2CameraControl
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.Camera2Interop
import androidx.camera.camera2.interop.CaptureRequestOptions
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.SurfaceOrientedMeteringPointFactory
import androidx.camera.core.UseCase
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.exifinterface.media.ExifInterface
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.Observer
import dev.pocket3d.capture.logic.AngularSpeedEstimator
import dev.pocket3d.capture.logic.Camera2Geometry
import dev.pocket3d.capture.logic.DeviceOrientation
import dev.pocket3d.capture.logic.OrientationViewpoint
import dev.pocket3d.capture.logic.ImageShift
import dev.pocket3d.capture.logic.YuvPacking
import dev.pocket3d.core.capture.FrameAnalysis
import dev.pocket3d.core.project.Distortion
import dev.pocket3d.core.project.ExposureInfo
import dev.pocket3d.core.project.FocusInfo
import dev.pocket3d.core.project.Intrinsics
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.coroutines.resume

/**
 * Photo engine without position tracking: CameraX `ImageCapture` at the camera's full standard
 * resolution, written straight to the session's temp file (no re-encode), plus
 *  * `ImageAnalysis` for live sharpness / exposure,
 *  * the rotation-vector sensor for an ESTIMATED viewpoint (orbit assumption — this engine cannot
 *    know where the phone is, only where it points),
 *  * Camera2 interop for AE/AF/AWB lock and for the lens calibration, when the device has them.
 *
 * All public functions are called on the main thread.
 */
@OptIn(ExperimentalCamera2Interop::class)
internal class CameraXEngine(context: Context) : CaptureEngine, ExposureLocking, SensorEventListener {
    private val app = context.applicationContext
    override val kind = EngineKind.CAMERA

    private val _live = MutableStateFlow(LiveSample())
    override val live: StateFlow<LiveSample> = _live
    private val _status = MutableStateFlow<EngineStatus>(EngineStatus.Starting)
    override val status: StateFlow<EngineStatus> = _status
    private val _info = MutableStateFlow(EngineInfo())
    override val info: StateFlow<EngineInfo> = _info

    private val mainExecutor = ContextCompat.getMainExecutor(app)
    private var analysisExecutor: ExecutorService? = null
    private var ioExecutor: ExecutorService? = null

    private var provider: ProcessCameraProvider? = null
    private var camera: Camera? = null
    private var imageCapture: ImageCapture? = null
    private var boundUseCases: List<UseCase> = emptyList()
    private var owner: LifecycleOwner? = null
    private var stateObserver: Observer<CameraState>? = null
    private var lifecycleObserver: LifecycleEventObserver? = null
    private var started = false

    // --- orientation sensor ---------------------------------------------------------------------
    private val sensorManager = app.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
    private val rotationSensor: Sensor? = sensorManager?.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
        ?: sensorManager?.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR)
    private val angularSpeed = AngularSpeedEstimator()
    private var sensorRegistered = false
    private var lastSensorPublishNs = 0L

    // --- camera facts (main thread unless noted) ----------------------------------------------------
    private var characteristics: Characteristics? = null
    /** Latest values from the repeating request's capture results (written on a camera thread). */
    @Volatile private var latestResult: ResultSnapshot? = null

    private class Characteristics(
        val cameraId: String,
        val sensorOrientation: Int,
        val active: Camera2Geometry.RectI?,
        val preCorrection: Camera2Geometry.RectI?,
        val calibration: FloatArray?,
        val lensDistortion: FloatArray?,
        /** The camera corrects lens distortion in its JPEG output: stored photos are already undistorted. */
        val correctsDistortion: Boolean,
        val aeLock: Boolean,
        val awbLock: Boolean,
        val afLock: Boolean,
        val fixedFocus: Boolean,
    )

    private class ResultSnapshot(
        val iso: Int?, val exposureNs: Long?, val focusDiopters: Float?,
        val aeState: Int?, val afState: Int?,
        val cropRegion: Camera2Geometry.RectI?,
        val calibration: FloatArray?, val lensDistortion: FloatArray?,
    )

    private val resultCallback = object : CameraCaptureSession.CaptureCallback() {
        override fun onCaptureCompleted(session: CameraCaptureSession, request: CaptureRequest, result: TotalCaptureResult) {
            latestResult = try {
                ResultSnapshot(
                    iso = result.get(CaptureResult.SENSOR_SENSITIVITY),
                    exposureNs = result.get(CaptureResult.SENSOR_EXPOSURE_TIME),
                    focusDiopters = result.get(CaptureResult.LENS_FOCUS_DISTANCE),
                    aeState = result.get(CaptureResult.CONTROL_AE_STATE),
                    afState = result.get(CaptureResult.CONTROL_AF_STATE),
                    cropRegion = result.get(CaptureResult.SCALER_CROP_REGION)?.toRectI(),
                    calibration = result.get(CaptureResult.LENS_INTRINSIC_CALIBRATION),
                    lensDistortion = if (Build.VERSION.SDK_INT >= 28) result.get(CaptureResult.LENS_DISTORTION) else null,
                )
            } catch (t: Throwable) {
                null
            }
        }
    }

    // =================================================================================================
    // Lifecycle
    // =================================================================================================

    /** Binds the camera to [lifecycleOwner]; the preview is shown in [previewView]. Safe to call again after [stop]. */
    fun start(lifecycleOwner: LifecycleOwner, previewView: PreviewView) {
        if (started) return
        started = true
        owner = lifecycleOwner
        _status.value = EngineStatus.Starting
        _info.update {
            it.copy(viewpointSource = if (rotationSensor != null) ViewpointSource.IMU else ViewpointSource.NONE)
        }
        analysisExecutor = Executors.newSingleThreadExecutor()
        ioExecutor = Executors.newSingleThreadExecutor()

        // The sensor only runs while the screen is in the foreground.
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> registerSensor()
                Lifecycle.Event.ON_PAUSE -> unregisterSensor()
                else -> Unit
            }
        }
        lifecycleObserver = observer
        lifecycleOwner.lifecycle.addObserver(observer)

        val future = try {
            ProcessCameraProvider.getInstance(app)
        } catch (t: Throwable) {
            _status.value = EngineStatus.Failed("The camera could not be initialised (${t.describe()}).")
            return
        }
        future.addListener({
            if (!started) return@addListener
            try {
                provider = future.get()
                bind(lifecycleOwner, previewView)
            } catch (t: Throwable) {
                _status.value = EngineStatus.Failed("The camera could not be started (${(t.cause ?: t).describe()}).")
            }
        }, mainExecutor)
    }

    private fun bind(lifecycleOwner: LifecycleOwner, previewView: PreviewView) {
        val provider = provider ?: return
        if (lifecycleOwner.lifecycle.currentState == Lifecycle.State.DESTROYED) return
        val selector = CameraSelector.DEFAULT_BACK_CAMERA
        val hasBack = try { provider.hasCamera(selector) } catch (t: Throwable) { false }
        if (!hasBack) {
            _status.value = EngineStatus.Failed("This device reports no usable back camera. You can still import photos.")
            return
        }

        val fourByThree = AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY
        val previewBuilder = Preview.Builder()
            .setResolutionSelector(ResolutionSelector.Builder().setAspectRatioStrategy(fourByThree).build())
        // Capture results of the repeating request: exposure, focus distance, 3A states, crop.
        Camera2Interop.Extender(previewBuilder).setSessionCaptureCallback(resultCallback)
        val preview = previewBuilder.build()

        // Highest standard resolution, best quality. (The device's ultra-high-resolution sensor
        // modes are deliberately not requested: they are slow, noisy in ordinary light and exceed
        // what the reconstruction needs.)
        val capture = ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
            .setJpegQuality(JPEG_QUALITY)
            .setFlashMode(ImageCapture.FLASH_MODE_OFF)
            .setResolutionSelector(
                ResolutionSelector.Builder()
                    .setAspectRatioStrategy(fourByThree)
                    .setResolutionStrategy(ResolutionStrategy.HIGHEST_AVAILABLE_STRATEGY)
                    .build())
            .build()

        val analysis = ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .setResolutionSelector(
                ResolutionSelector.Builder()
                    .setAspectRatioStrategy(fourByThree)
                    .setResolutionStrategy(ResolutionStrategy(Size(640, 480), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                    .build())
            .build()
        analysisExecutor?.let { analysis.setAnalyzer(it, ::analyze) }

        val cam: Camera = try {
            provider.bindToLifecycle(lifecycleOwner, selector, preview, capture, analysis).also {
                boundUseCases = listOf(preview, capture, analysis)
            }
        } catch (first: Throwable) {
            // Some LEGACY devices cannot run three streams: drop the live analysis, keep the photos.
            try {
                provider.unbind(preview, capture, analysis)
                provider.bindToLifecycle(lifecycleOwner, selector, preview, capture).also {
                    boundUseCases = listOf(preview, capture)
                }
            } catch (second: Throwable) {
                _status.value = EngineStatus.Failed("The camera could not be configured (${second.describe()}).")
                return
            }
        }
        camera = cam
        imageCapture = capture
        preview.setSurfaceProvider(previewView.surfaceProvider)

        characteristics = readCharacteristics(cam)
        val c = characteristics
        val size = capture.resolutionInfo?.resolution
        _info.update {
            it.copy(
                photoWidth = size?.width ?: 0, photoHeight = size?.height ?: 0,
                previewAspect = 3f / 4f,
                cameraId = c?.cameraId,
                lock = LockState(
                    anySupported = c != null && (c.aeLock || c.afLock || c.awbLock),
                    aeSupported = c?.aeLock == true, afSupported = c?.afLock == true, awbSupported = c?.awbLock == true,
                    fixedFocus = c?.fixedFocus == true,
                ),
            )
        }

        val obs = Observer<CameraState> { state -> onCameraState(state) }
        stateObserver = obs
        cam.cameraInfo.cameraState.observe(lifecycleOwner, obs)
        if (lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) registerSensor()
    }

    private fun onCameraState(state: CameraState) {
        val error = state.error
        if (error != null) {
            val text = when (error.code) {
                CameraState.ERROR_CAMERA_IN_USE ->
                    "The camera is being used by another app. Capture continues here when that app releases it."
                CameraState.ERROR_MAX_CAMERAS_IN_USE ->
                    "Too many cameras are open on this device. Close other camera apps; capture continues automatically."
                CameraState.ERROR_OTHER_RECOVERABLE_ERROR -> "The camera had a temporary problem and is restarting."
                CameraState.ERROR_STREAM_CONFIG -> "The camera rejected the stream configuration."
                CameraState.ERROR_CAMERA_DISABLED -> "The camera is disabled on this device (device policy)."
                CameraState.ERROR_CAMERA_FATAL_ERROR -> "The camera reported a fatal error. Restarting the phone may be needed."
                CameraState.ERROR_DO_NOT_DISTURB_MODE_ENABLED ->
                    "The camera cannot open while Do Not Disturb is on (a limitation of this Android version)."
                else -> "The camera reported an error (code ${error.code})."
            }
            val recoverable = error.code == CameraState.ERROR_CAMERA_IN_USE || error.code == CameraState.ERROR_MAX_CAMERAS_IN_USE ||
                error.code == CameraState.ERROR_OTHER_RECOVERABLE_ERROR
            _status.value = if (recoverable) EngineStatus.Interrupted(text) else EngineStatus.Failed(text)
            return
        }
        when (state.type) {
            CameraState.Type.OPEN -> _status.value = EngineStatus.Running
            CameraState.Type.OPENING, CameraState.Type.PENDING_OPEN ->
                if (_status.value !is EngineStatus.Interrupted) _status.value = EngineStatus.Starting
            else -> Unit   // CLOSING / CLOSED while paused: the lifecycle reopens it on resume
        }
    }

    /** Unbinds the camera and releases everything. */
    fun stop() {
        if (!started) return
        started = false
        unregisterSensor()
        lifecycleObserver?.let { o -> owner?.lifecycle?.removeObserver(o) }
        lifecycleObserver = null
        val cam = camera
        stateObserver?.let { o -> cam?.cameraInfo?.cameraState?.removeObserver(o) }
        stateObserver = null
        try {
            if (cam != null && _info.value.lock.requested) {
                cam.cameraControl.cancelFocusAndMetering()
                Camera2CameraControl.from(cam.cameraControl).clearCaptureRequestOptions()
            }
        } catch (_: Throwable) { }
        try { provider?.unbind(*boundUseCases.toTypedArray()) } catch (_: Throwable) { }
        boundUseCases = emptyList()
        camera = null
        imageCapture = null
        owner = null
        analysisExecutor?.shutdown(); analysisExecutor = null
        ioExecutor?.shutdown(); ioExecutor = null
        latestResult = null
        _status.value = EngineStatus.Starting
    }

    // =================================================================================================
    // Live analysis and orientation
    // =================================================================================================

    private var prevLuma: ByteArray? = null
    private var prevW = 0
    private var prevH = 0
    private var shiftX = 0.0
    private var shiftY = 0.0
    private var shiftValid = 0L
    private var shiftFrames = 0L

    /** Focal length in pixels of the analysis image (its long side spans the sensor's long side), if the camera reports it. */
    private fun analysisFocalPx(analysisWidth: Int): Float? = try {
        val cam = camera ?: return null
        val ch = Camera2CameraInfo.from(cam.cameraInfo)
        val focal = ch.getCameraCharacteristic(android.hardware.camera2.CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.firstOrNull()
        val size = ch.getCameraCharacteristic(android.hardware.camera2.CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)
        if (focal != null && size != null && focal > 0f && size.width > 0f) {
            (analysisWidth * focal / maxOf(size.width, size.height)).takeIf { it > 0.3f * analysisWidth && it < 4f * analysisWidth }
        } else null
    } catch (_: Throwable) { null }

    private fun analyze(image: ImageProxy) {
        try {
            val plane = image.planes[0]
            val (luma, w, h) = YuvPacking.analysisLuma(plane.buffer, image.width, image.height, plane.rowStride, plane.pixelStride)
            val (quality, flags) = FrameAnalysis.analyze(luma, w, h)
            val hash = FrameAnalysis.dHash(luma, w, h)
            // centre-of-picture shift for the turning-on-the-spot check
            val prev = prevLuma
            shiftFrames++
            if (prev != null && prevW == w && prevH == h) {
                ImageShift.estimate(prev, luma, w, h)?.let { sh ->
                    shiftX += sh.dx; shiftY += sh.dy; shiftValid++
                }
            }
            prevLuma = luma; prevW = w; prevH = h
            _live.update { it.copy(liveFlags = flags, liveSharpness = quality.sharpness, liveHash = hash,
                centreShiftX = shiftX, centreShiftY = shiftY, centreShiftValid = shiftValid,
                centreShiftFrames = shiftFrames, analysisWidth = w, analysisFocalPx = analysisFocalPx(w)) }
        } catch (_: Throwable) {
            // A malformed frame must never take the camera down; the next frame is analysed instead.
        } finally {
            image.close()
        }
    }

    private fun registerSensor() {
        val s = rotationSensor ?: return
        if (sensorRegistered || !started) return
        angularSpeed.reset()
        sensorRegistered = sensorManager?.registerListener(this, s, SensorManager.SENSOR_DELAY_GAME) == true
    }

    private fun unregisterSensor() {
        if (!sensorRegistered) return
        sensorManager?.unregisterListener(this)
        sensorRegistered = false
    }

    override fun onSensorChanged(event: SensorEvent) {
        if (event.sensor.type != Sensor.TYPE_ROTATION_VECTOR && event.sensor.type != Sensor.TYPE_GAME_ROTATION_VECTOR) return
        val q = OrientationViewpoint.quatFromRotationVector(event.values)
        val speed = angularSpeed.update(q, event.timestamp)
        if (event.timestamp - lastSensorPublishNs < SENSOR_PUBLISH_INTERVAL_NS) return
        lastSensorPublishNs = event.timestamp
        val dir = OrientationViewpoint.dirFromDeviceQuat(q)
        _live.update { it.copy(timeNs = event.timestamp, orientationDir = dir, angularSpeedDegS = speed) }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    // =================================================================================================
    // Focus / exposure lock
    // =================================================================================================

    /**
     * Locks (or releases) focus, exposure and white balance where the device supports it:
     * autofocus once on the centre of the frame and hold it, then freeze AE and AWB. What cannot
     * be locked is reported in [LockState], never silently ignored.
     */
    override fun setLock(lock: Boolean) {
        val cam = camera ?: return
        val c = characteristics ?: return
        val state = _info.value.lock
        if (!state.anySupported) return
        val control = cam.cameraControl
        val interop = Camera2CameraControl.from(control)
        if (!lock) {
            try {
                control.cancelFocusAndMetering()
                interop.clearCaptureRequestOptions()
            } catch (_: Throwable) { }
            _info.update { it.copy(lock = it.lock.copy(requested = false, inProgress = false, detail = null)) }
            return
        }
        _info.update { it.copy(lock = it.lock.copy(requested = true, inProgress = true, detail = "Focusing…")) }

        fun freezeExposure(focusNote: String) {
            try {
                val options = CaptureRequestOptions.Builder()
                if (c.aeLock) options.setCaptureRequestOption(CaptureRequest.CONTROL_AE_LOCK, true)
                if (c.awbLock) options.setCaptureRequestOption(CaptureRequest.CONTROL_AWB_LOCK, true)
                interop.setCaptureRequestOptions(options.build())
            } catch (t: Throwable) {
                _info.update { it.copy(lock = it.lock.copy(requested = false, inProgress = false,
                                                           detail = "Locking failed (${t.describe()}).")) }
                return
            }
            val locked = buildList {
                add(focusNote)
                add(if (c.aeLock) "exposure locked" else "exposure cannot be locked")
                add(if (c.awbLock) "white balance locked" else "white balance cannot be locked")
            }.joinToString(", ")
            _info.update { it.copy(lock = it.lock.copy(inProgress = false, detail = locked.replaceFirstChar(Char::uppercase))) }
        }

        if (!c.afLock) {
            freezeExposure(if (c.fixedFocus) "fixed-focus lens" else "focus cannot be locked")
            return
        }
        try {
            val point = SurfaceOrientedMeteringPointFactory(1f, 1f).createPoint(0.5f, 0.5f, 0.3f)
            val action = FocusMeteringAction.Builder(point, FocusMeteringAction.FLAG_AF or FocusMeteringAction.FLAG_AE or FocusMeteringAction.FLAG_AWB)
                .disableAutoCancel()   // hold until the user unlocks
                .build()
            val future = control.startFocusAndMetering(action)
            future.addListener({
                if (!started || !_info.value.lock.requested) return@addListener
                val focused = try { future.get().isFocusSuccessful } catch (t: Throwable) { false }
                freezeExposure(if (focused) "focus locked" else "focus held, but the camera did not confirm sharp focus")
            }, mainExecutor)
        } catch (t: Throwable) {
            freezeExposure("focus could not be locked")
        }
    }

    // =================================================================================================
    // Capture
    // =================================================================================================

    override suspend fun capture(target: File, deviceRotationCw: Int): CaptureOutcome = withContext(Dispatchers.Main.immediate) {
        val capture = imageCapture ?: return@withContext CaptureOutcome.Failure("The camera is not ready yet.")
        val io = ioExecutor ?: return@withContext CaptureOutcome.Failure("The camera is not ready yet.")
        if (_status.value !is EngineStatus.Running) return@withContext CaptureOutcome.Failure("The camera is not available right now.")
        val c = characteristics
        val atPress = _live.value
        val lock = _info.value.lock
        try {
            // The UI may be portrait-locked: the photo's orientation follows how the phone is held.
            capture.targetRotation = DeviceOrientation.surfaceRotation(deviceRotationCw)
        } catch (_: Throwable) { }
        val timestampMs = System.currentTimeMillis()

        val error: ImageCaptureException? = suspendCancellableCoroutine { cont ->
            try {
                capture.takePicture(ImageCapture.OutputFileOptions.Builder(target).build(), io,
                    object : ImageCapture.OnImageSavedCallback {
                        override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
                            if (cont.isActive) cont.resume(null)
                        }
                        override fun onError(exception: ImageCaptureException) {
                            if (cont.isActive) cont.resume(exception)
                        }
                    })
            } catch (t: Throwable) {
                if (cont.isActive) cont.resume(ImageCaptureException(ImageCapture.ERROR_UNKNOWN, t.describe(), t))
            }
        }
        if (error != null) {
            target.delete()
            return@withContext CaptureOutcome.Failure(describeCaptureError(error))
        }
        val result = latestResult

        withContext(Dispatchers.IO) {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(target.path, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || target.length() == 0L) {
                target.delete()
                return@withContext CaptureOutcome.Failure("The camera produced an unreadable photo. Nothing was saved.")
            }
            // The file is the truth: read what the camera actually stored.
            var exifOrientation = ExifInterface.ORIENTATION_NORMAL
            var exifIso: Int? = null
            var exifExposureNs: Long? = null
            try {
                val exif = ExifInterface(target)
                exifOrientation = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
                    .let { if (it in 1..8) it else ExifInterface.ORIENTATION_NORMAL }
                exifIso = exif.getAttributeInt(ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY, 0).takeIf { it > 0 }
                exifExposureNs = exif.getAttributeDouble(ExifInterface.TAG_EXPOSURE_TIME, 0.0)
                    .takeIf { it > 0.0 && it.isFinite() }?.let { (it * 1e9).toLong() }
            } catch (_: Throwable) { }

            var intrinsics: Intrinsics? = null
            var distortion: Distortion? = null
            if (c != null) {
                // Normally the rotation is only an EXIF tag. A camera that rotated the pixels
                // instead stores orientation 1 although a rotation was requested.
                val requested = DeviceOrientation.imageRotationCw(c.sensorOrientation, deviceRotationCw)
                val pixelTurns = if (exifOrientation == ExifInterface.ORIENTATION_NORMAL) requested / 90 else 0
                val k = Camera2Geometry.intrinsicsForStoredImage(
                    result?.calibration ?: c.calibration, c.preCorrection, c.active, result?.cropRegion,
                    bounds.outWidth, bounds.outHeight, pixelTurns)
                if (k != null) {
                    intrinsics = Intrinsics(k.fx, k.fy, k.cx, k.cy, source = "camera2")
                    // Coefficients only describe the stored pixels if the camera did not already
                    // undistort them, and only in sensor orientation.
                    if (!c.correctsDistortion && pixelTurns == 0) {
                        Camera2Geometry.opencvDistortion(result?.lensDistortion ?: c.lensDistortion)?.let {
                            distortion = Distortion(model = "opencv5", k = it)
                        }
                    }
                }
            }

            val afLocked = result?.afState == CameraMetadata.CONTROL_AF_STATE_FOCUSED_LOCKED ||
                result?.afState == CameraMetadata.CONTROL_AF_STATE_NOT_FOCUSED_LOCKED
            val focusLocked = (c?.fixedFocus == true) ||
                (lock.requested && !lock.inProgress && c?.afLock == true && (result == null || afLocked))
            val aeLocked = lock.requested && !lock.inProgress && c?.aeLock == true &&
                (result == null || result.aeState == CameraMetadata.CONTROL_AE_STATE_LOCKED)

            CaptureOutcome.Success(RawCapture(
                file = target, timestampMs = timestampMs,
                width = bounds.outWidth, height = bounds.outHeight, exifOrientation = exifOrientation,
                intrinsics = intrinsics, distortion = distortion,
                position = null, rotation = null, trackingLost = false,
                orientationDir = atPress.orientationDir,
                angularSpeedDegS = atPress.angularSpeedDegS, linearSpeedMS = null,
                focus = FocusInfo(locked = focusLocked, distanceDiopters = result?.focusDiopters?.toDouble()?.takeIf { it.isFinite() && it >= 0.0 }),
                exposure = ExposureInfo(locked = aeLocked, iso = exifIso ?: result?.iso, exposureNs = exifExposureNs ?: result?.exposureNs),
                analysisLuma = JpegLuma.analysisLuma(target, bounds.outWidth),
            ))
        }
    }

    private fun describeCaptureError(e: ImageCaptureException): String = when (e.imageCaptureError) {
        ImageCapture.ERROR_FILE_IO -> "The photo could not be written to storage (${(e.cause ?: e).describe()})."
        ImageCapture.ERROR_CAMERA_CLOSED -> "The camera was closed before the photo was taken."
        ImageCapture.ERROR_CAPTURE_FAILED -> "The camera failed to take the photo. Try again."
        ImageCapture.ERROR_INVALID_CAMERA -> "The camera is not available."
        else -> "The photo could not be taken (${(e.cause ?: e).describe()})."
    }

    private fun readCharacteristics(cam: Camera): Characteristics? = try {
        val info = Camera2CameraInfo.from(cam.cameraInfo)
        val afModes = info.getCameraCharacteristic(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES) ?: IntArray(0)
        val minFocus = info.getCameraCharacteristic(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE) ?: 0f
        val hasAf = minFocus > 0f && afModes.contains(CameraMetadata.CONTROL_AF_MODE_AUTO)
        val correctionModes = if (Build.VERSION.SDK_INT >= 28)
            info.getCameraCharacteristic(CameraCharacteristics.DISTORTION_CORRECTION_AVAILABLE_MODES) else null
        Characteristics(
            cameraId = info.cameraId,
            sensorOrientation = info.getCameraCharacteristic(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90,
            active = info.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE)?.toRectI(),
            preCorrection = info.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_PRE_CORRECTION_ACTIVE_ARRAY_SIZE)?.toRectI(),
            calibration = info.getCameraCharacteristic(CameraCharacteristics.LENS_INTRINSIC_CALIBRATION),
            lensDistortion = if (Build.VERSION.SDK_INT >= 28) info.getCameraCharacteristic(CameraCharacteristics.LENS_DISTORTION) else null,
            correctsDistortion = correctionModes?.any { it != CameraMetadata.DISTORTION_CORRECTION_MODE_OFF } == true,
            aeLock = info.getCameraCharacteristic(CameraCharacteristics.CONTROL_AE_LOCK_AVAILABLE) == true,
            awbLock = info.getCameraCharacteristic(CameraCharacteristics.CONTROL_AWB_LOCK_AVAILABLE) == true,
            afLock = hasAf,
            fixedFocus = !(minFocus > 0f),
        )
    } catch (t: Throwable) {
        null
    }

    private companion object {
        const val JPEG_QUALITY = 97
        const val SENSOR_PUBLISH_INTERVAL_NS = 50_000_000L   // 20 Hz
    }
}

private fun Rect.toRectI() = Camera2Geometry.RectI(left, top, right, bottom)

internal fun Throwable.describe(): String = message?.takeIf { it.isNotBlank() }?.take(140) ?: javaClass.simpleName
