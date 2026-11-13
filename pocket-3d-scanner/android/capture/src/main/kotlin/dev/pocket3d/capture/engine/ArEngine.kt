package dev.pocket3d.capture.engine

import android.content.Context
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.Image
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.view.Surface
import androidx.exifinterface.media.ExifInterface
import com.google.ar.core.Anchor
import com.google.ar.core.Camera
import com.google.ar.core.CameraConfig
import com.google.ar.core.CameraConfigFilter
import com.google.ar.core.Config
import com.google.ar.core.DepthPoint
import com.google.ar.core.Frame
import com.google.ar.core.ImageMetadata
import com.google.ar.core.Plane
import com.google.ar.core.Point
import com.google.ar.core.Session
import com.google.ar.core.TrackingFailureReason
import com.google.ar.core.TrackingState
import com.google.ar.core.exceptions.CameraNotAvailableException
import com.google.ar.core.exceptions.DeadlineExceededException
import com.google.ar.core.exceptions.NotYetAvailableException
import com.google.ar.core.exceptions.ResourceExhaustedException
import com.google.ar.core.exceptions.SessionPausedException
import com.google.ar.core.exceptions.UnavailableApkTooOldException
import com.google.ar.core.exceptions.UnavailableArcoreNotInstalledException
import com.google.ar.core.exceptions.UnavailableDeviceNotCompatibleException
import com.google.ar.core.exceptions.UnavailableSdkTooOldException
import dev.pocket3d.capture.CapabilityProbe
import dev.pocket3d.capture.logic.AngularSpeedEstimator
import dev.pocket3d.capture.logic.DeviceOrientation
import dev.pocket3d.capture.logic.LinearSpeedEstimator
import dev.pocket3d.capture.logic.OrientationViewpoint
import dev.pocket3d.capture.logic.YuvPacking
import dev.pocket3d.core.capture.FrameAnalysis
import dev.pocket3d.core.services.ArRuntimeStatus
import dev.pocket3d.core.capture.ImageGeometry
import dev.pocket3d.core.math.Quat
import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.project.ExposureInfo
import dev.pocket3d.core.project.FocusInfo
import dev.pocket3d.core.project.Intrinsics
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10

/**
 * AR-tracked engine: an ARCore session on the back camera, rendered into a [GLSurfaceView].
 * Photos are the ARCore CPU images (YUV_420_888), encoded to JPEG exactly once.
 *
 * Threading, as in the official hello_ar_java sample: the session is created / resumed / paused
 * on the main thread, `Session.update()` and everything that touches a `Frame` runs on the GL
 * thread. Requests from the main thread (take a photo, set the object) are handed to the GL
 * thread through atomic slots and answered with a `CompletableDeferred`.
 *
 * Every failure ends in [EngineStatus.Failed] with a concrete message; the screen then falls back
 * to the CameraX engine.
 */
internal class ArEngine(context: Context) : CaptureEngine, ObjectAiming, GLSurfaceView.Renderer {
    private val app = context.applicationContext
    override val kind = EngineKind.AR

    private val _live = MutableStateFlow(LiveSample(trackingLabel = "Starting…"))
    override val live: StateFlow<LiveSample> = _live
    private val _status = MutableStateFlow<EngineStatus>(EngineStatus.Starting)
    override val status: StateFlow<EngineStatus> = _status
    private val _info = MutableStateFlow(EngineInfo(viewpointSource = ViewpointSource.ARCORE, previewAspect = 9f / 16f))
    override val info: StateFlow<EngineInfo> = _info

    private var glView: GLSurfaceView? = null
    @Volatile private var session: Session? = null
    @Volatile private var resumed = false
    @Volatile private var destroyed = false
    private var sensorOrientation = 90
    private var encodeExecutor: ExecutorService? = Executors.newSingleThreadExecutor()

    // --- GL-thread state --------------------------------------------------------------------------
    private val background = ArBackgroundRenderer()
    private var viewportWidth = 0
    private var viewportHeight = 0
    private var displayRotation = -1
    @Volatile private var geometryDirty = true
    private var wasTracking = false
    private var epoch = 0
    private var anchor: Anchor? = null
    private var frameCounter = 0
    private var consecutiveErrors = 0
    private val angularSpeed = AngularSpeedEstimator()
    private val linearSpeed = LinearSpeedEstimator()
    private var liveFlags: List<String>? = null
    private var liveSharpness: Double? = null
    private var liveHash: Long? = null

    private class CaptureRequest(val target: File, val deviceRotationCw: Int) {
        val result = CompletableDeferred<CaptureOutcome>()
        var attempts = 0
        @Volatile var abandoned = false
    }
    private val pendingCapture = AtomicReference<CaptureRequest?>(null)
    private val pendingAim = AtomicReference<CompletableDeferred<ObjectHit>?>(null)

    // =================================================================================================
    // Main-thread lifecycle
    // =================================================================================================

    /** Configures [view] to render this engine. Call once, before the view is attached. */
    fun bind(view: GLSurfaceView) {
        view.preserveEGLContextOnPause = true
        view.setEGLContextClientVersion(2)
        view.setEGLConfigChooser(8, 8, 8, 8, 16, 0)
        view.setRenderer(this)
        view.renderMode = GLSurfaceView.RENDERMODE_CONTINUOUSLY
        glView = view
    }

    /**
     * Creates the session if needed and resumes it. Returns null on success, otherwise the reason
     * AR tracking cannot run (the engine is then unusable and must be destroyed).
     */
    fun resume(): String? {
        if (destroyed) return "AR tracking was shut down."
        if (resumed) return null
        val error: String? = try {
            var s = session
            if (s == null) {
                s = Session(app)
                try {
                    configure(s)
                } catch (t: Throwable) {
                    try { s.close() } catch (_: Throwable) { }
                    throw t
                }
                session = s
                CapabilityProbe.arSessionActive.set(true)
            }
            s.resume()
            null
        } catch (e: UnavailableArcoreNotInstalledException) {
            "Google Play Services for AR is not installed."
        } catch (e: UnavailableApkTooOldException) {
            "Google Play Services for AR is too old and must be updated."
        } catch (e: UnavailableSdkTooOldException) {
            "This app version is too old for the installed Google Play Services for AR."
        } catch (e: UnavailableDeviceNotCompatibleException) {
            "This phone is not compatible with ARCore motion tracking."
        } catch (e: CameraNotAvailableException) {
            "The camera could not be opened for AR tracking (another app may be using it)."
        } catch (e: SecurityException) {
            "The camera permission is missing."
        } catch (t: Throwable) {
            // e.g. com.google.ar.core.exceptions.FatalException: Google Play Services for AR is
            // installed but cannot run here (unsupported device profile, emulator without a GPU…).
            "Google Play Services for AR reported an internal error and could not start on this device " +
                "(${t.javaClass.simpleName})."
        }
        if (error != null) {
            ArRuntimeStatus.reportFailed(error)
            _status.value = EngineStatus.Failed(error)
            return error
        }
        resumed = true
        geometryDirty = true
        ArRuntimeStatus.reportStarted()
        _status.value = EngineStatus.Running
        glView?.onResume()
        return null
    }

    private fun configure(s: Session) {
        // Largest CPU image the back camera offers: that image is what gets stored.
        val filter = CameraConfigFilter(s).setFacingDirection(CameraConfig.FacingDirection.BACK)
        val best = s.getSupportedCameraConfigs(filter).maxByOrNull { it.imageSize.width.toLong() * it.imageSize.height }
        if (best != null) s.setCameraConfig(best)

        val depthSupported = s.isDepthModeSupported(Config.DepthMode.AUTOMATIC)
        CapabilityProbe.reportArDepthSupport(depthSupported)
        val config = Config(s)
        config.setFocusMode(Config.FocusMode.AUTO)
        config.setPlaneFindingMode(Config.PlaneFindingMode.HORIZONTAL)
        config.setUpdateMode(Config.UpdateMode.LATEST_CAMERA_IMAGE)
        config.setLightEstimationMode(Config.LightEstimationMode.DISABLED)
        // Depth only helps to hit-test the object centre. It is never stored or used for reconstruction.
        config.setDepthMode(if (depthSupported) Config.DepthMode.AUTOMATIC else Config.DepthMode.DISABLED)
        s.configure(config)

        val cameraConfig = s.cameraConfig
        val size = cameraConfig.imageSize
        sensorOrientation = try {
            val manager = app.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            manager.getCameraCharacteristics(cameraConfig.cameraId).get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
        } catch (t: Throwable) { 90 }
        _info.update {
            it.copy(
                photoWidth = size.width, photoHeight = size.height,
                // Shown in portrait: the preview box has the proportions of the stored image.
                previewAspect = minOf(size.width, size.height).toFloat() / maxOf(size.width, size.height),
                arDepthSupported = depthSupported, intrinsicsSource = "arcore", cameraId = cameraConfig.cameraId,
            )
        }
    }

    fun pause() {
        if (!resumed) return
        resumed = false
        // GLSurfaceView.onPause() returns only after the render thread has stopped drawing, so no
        // Session.update() can run concurrently with Session.pause().
        glView?.onPause()
        try { session?.pause() } catch (_: Throwable) { }
        failPending("Capture was interrupted because the app went to the background.")
        _live.update { LiveSample(trackingLabel = "Paused", trackingEpoch = it.trackingEpoch) }
    }

    /** Releases the session and the camera. The engine cannot be used afterwards. */
    fun destroy() {
        if (destroyed) return
        pause()
        destroyed = true
        val s = session
        session = null
        anchor = null
        encodeExecutor?.shutdown()
        encodeExecutor = null
        if (s != null) {
            // Session.close() can block for a while; the camera is free once it returns.
            Thread({
                try { s.close() } catch (_: Throwable) { }
                CapabilityProbe.arSessionActive.set(false)
            }, "ar-session-close").start()
        }
    }

    private fun failPending(message: String) {
        pendingCapture.getAndSet(null)?.result?.complete(CaptureOutcome.Failure(message))
        pendingAim.getAndSet(null)?.complete(ObjectHit.Missed(message))
    }

    private fun fail(message: String) {
        if (_status.value is EngineStatus.Failed) return
        _status.value = EngineStatus.Failed(message)
        failPending(message)
    }

    // =================================================================================================
    // Requests from the main thread
    // =================================================================================================

    override suspend fun capture(target: File, deviceRotationCw: Int): CaptureOutcome {
        if (!resumed || session == null) return CaptureOutcome.Failure("AR tracking is not running.")
        val request = CaptureRequest(target, deviceRotationCw)
        if (!pendingCapture.compareAndSet(null, request)) return CaptureOutcome.Failure("The previous photo is still being taken.")
        val outcome = withTimeoutOrNull(CAPTURE_TIMEOUT_MS) { request.result.await() }
        if (outcome != null) return outcome
        request.abandoned = true
        pendingCapture.compareAndSet(request, null)
        return CaptureOutcome.Failure("The camera did not deliver an image in time. Try again.")
    }

    override suspend fun setObjectAtReticle(): ObjectHit {
        if (!resumed || session == null) return ObjectHit.Missed("AR tracking is not running.")
        val deferred = CompletableDeferred<ObjectHit>()
        pendingAim.getAndSet(deferred)?.complete(ObjectHit.Missed("Replaced by a newer request."))
        return withTimeoutOrNull(AIM_TIMEOUT_MS) { deferred.await() }
            ?: ObjectHit.Missed("AR tracking did not answer in time. Try again.").also { pendingAim.compareAndSet(deferred, null) }
    }

    // =================================================================================================
    // GL thread
    // =================================================================================================

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        GLES20.glClearColor(0f, 0f, 0f, 1f)
        try {
            background.createOnGlThread()
        } catch (t: Throwable) {
            fail("The camera view could not be created (${t.describe()}).")
        }
    }

    override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
        viewportWidth = width
        viewportHeight = height
        GLES20.glViewport(0, 0, width, height)
        geometryDirty = true
    }

    override fun onDrawFrame(gl: GL10?) {
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
        val s = session ?: return
        if (!resumed || background.textureId < 0 || viewportWidth == 0) return
        try {
            val rotation = glView?.display?.rotation ?: Surface.ROTATION_0
            if (geometryDirty || rotation != displayRotation) {
                displayRotation = rotation
                geometryDirty = false
                s.setDisplayGeometry(rotation, viewportWidth, viewportHeight)
            }
            s.setCameraTextureName(background.textureId)
            val frame = s.update()
            background.draw(frame)
            if (frame.timestamp != 0L) onFrame(frame)
            consecutiveErrors = 0
        } catch (e: SessionPausedException) {
            // pause() raced with this frame; nothing to do.
        } catch (e: CameraNotAvailableException) {
            fail("The camera stopped delivering images to AR tracking (another app may have taken it).")
        } catch (t: Throwable) {
            if (++consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) fail("ARCore stopped working (${t.describe()}).")
        }
    }

    private fun onFrame(frame: Frame) {
        val camera = frame.camera
        val tracking = camera.trackingState == TrackingState.TRACKING
        if (wasTracking && !tracking) epoch++
        wasTracking = tracking

        var position: Vec3? = null
        var rotation: Quat? = null
        var angular: Double? = null
        var linear: Double? = null
        if (tracking) {
            val pose = camera.pose
            position = Vec3(pose.tx(), pose.ty(), pose.tz())
            rotation = Quat(pose.qx(), pose.qy(), pose.qz(), pose.qw()).normalized()
            angular = angularSpeed.update(rotation, frame.timestamp)
            linear = linearSpeed.update(position, frame.timestamp)
        } else {
            angularSpeed.reset()
            linearSpeed.reset()
        }

        pendingAim.getAndSet(null)?.complete(aim(frame, tracking))

        val request = pendingCapture.get()
        if (request != null) {
            takePhoto(request, frame, camera, tracking, position, rotation, angular, linear)
        } else if (++frameCounter % ANALYSIS_EVERY_N_FRAMES == 0) {
            analyseLive(frame)
        }

        val center = anchor?.takeIf { tracking && it.trackingState == TrackingState.TRACKING }?.pose?.let { Vec3(it.tx(), it.ty(), it.tz()) }
        _live.value = LiveSample(
            timeNs = frame.timestamp,
            trackingOk = tracking,
            trackingLabel = when (camera.trackingState) {
                TrackingState.TRACKING -> "Tracking"
                TrackingState.PAUSED -> "Tracking paused"
                else -> "Tracking stopped"
            },
            trackingAdvice = if (tracking) null else advice(camera.trackingFailureReason),
            trackingEpoch = epoch,
            position = position,
            forward = rotation?.let { ImageGeometry.forward(it) },
            orientationDir = rotation?.let { OrientationViewpoint.dirFromCameraQuat(it) },
            angularSpeedDegS = angular, linearSpeedMS = linear,
            objectCenter = center,
            liveFlags = liveFlags, liveSharpness = liveSharpness, liveHash = liveHash,
        )
    }

    private fun advice(reason: TrackingFailureReason): String = when (reason) {
        TrackingFailureReason.NONE -> "Move the phone slowly from side to side so tracking can start."
        TrackingFailureReason.BAD_STATE -> "Tracking is in a bad state. Hold still for a moment; if it does not recover, leave and reopen capture."
        TrackingFailureReason.INSUFFICIENT_LIGHT -> "Too dark to track — turn on more light."
        TrackingFailureReason.EXCESSIVE_MOTION -> "Moving too fast to track — slow down."
        TrackingFailureReason.INSUFFICIENT_FEATURES ->
            "Not enough visual detail to track — avoid blank walls and plain tabletops; a newspaper or patterned cloth under the object helps."
        TrackingFailureReason.CAMERA_UNAVAILABLE -> "Another app is using the camera. Tracking resumes when it is released."
    }

    /** Hit test at the centre of the view: the nearest depth point, feature point or detected plane. */
    private fun aim(frame: Frame, tracking: Boolean): ObjectHit {
        if (!tracking) return ObjectHit.Missed("Motion tracking is not running yet. Move the phone slowly until it says “Tracking”, then try again.")
        try {
            for (hit in frame.hitTest(viewportWidth / 2f, viewportHeight / 2f)) {
                val trackable = hit.trackable
                val surface = when {
                    trackable is DepthPoint -> "a depth point"
                    trackable is Point -> "a tracked feature point"
                    trackable is Plane && trackable.isPoseInPolygon(hit.hitPose) -> "a detected surface"
                    else -> continue
                }
                if (hit.distance < MIN_OBJECT_DISTANCE_M || hit.distance > MAX_OBJECT_DISTANCE_M) continue
                val created = try { hit.createAnchor() } catch (t: Throwable) { continue }
                try { anchor?.detach() } catch (_: Throwable) { }
                anchor = created
                val p = created.pose
                return ObjectHit.Found(Vec3(p.tx(), p.ty(), p.tz()), hit.distance, surface)
            }
        } catch (t: Throwable) {
            return ObjectHit.Missed("The object could not be located (${t.describe()}).")
        }
        return ObjectHit.Missed(
            "Nothing was detected at the reticle. Move the phone a little sideways while aiming at the object, then try " +
                "again — or continue without: coverage is then estimated from the phone's orientation.")
    }

    private fun analyseLive(frame: Frame) {
        val image: Image = try { frame.acquireCameraImage() } catch (t: Throwable) { return }
        try {
            val plane = image.planes[0]
            val (luma, w, h) = YuvPacking.analysisLuma(plane.buffer, image.width, image.height, plane.rowStride, plane.pixelStride)
            val (quality, flags) = FrameAnalysis.analyze(luma, w, h)
            liveFlags = flags
            liveSharpness = quality.sharpness
            liveHash = FrameAnalysis.dHash(luma, w, h)
        } catch (_: Throwable) {
        } finally {
            image.close()
        }
    }

    private fun takePhoto(request: CaptureRequest, frame: Frame, camera: Camera, tracking: Boolean,
                          position: Vec3?, rotation: Quat?, angular: Double?, linear: Double?) {
        if (request.abandoned) { pendingCapture.compareAndSet(request, null); return }
        val image: Image = try {
            frame.acquireCameraImage()
        } catch (e: NotYetAvailableException) {
            // No CPU image for this frame yet: try the next frames.
            if (++request.attempts > MAX_IMAGE_ATTEMPTS) finish(request, CaptureOutcome.Failure("The camera image was not available. Try again."))
            return
        } catch (e: DeadlineExceededException) {
            if (++request.attempts > MAX_IMAGE_ATTEMPTS) finish(request, CaptureOutcome.Failure("The camera image was not available. Try again."))
            return
        } catch (e: ResourceExhaustedException) {
            finish(request, CaptureOutcome.Failure("Too many camera images are in use at once. Try again."))
            return
        } catch (t: Throwable) {
            finish(request, CaptureOutcome.Failure("The camera image could not be read (${t.describe()})."))
            return
        }
        pendingCapture.compareAndSet(request, null)

        val timestampMs = System.currentTimeMillis()
        val width: Int
        val height: Int
        val nv21: ByteArray
        val luma: Triple<ByteArray, Int, Int>?
        try {
            if (image.format != ImageFormat.YUV_420_888) {
                request.result.complete(CaptureOutcome.Failure("The camera delivered an unexpected image format."))
                return
            }
            width = image.width
            height = image.height
            val y = image.planes[0]; val u = image.planes[1]; val v = image.planes[2]
            nv21 = YuvPacking.nv21(width, height, y.buffer, y.rowStride, y.pixelStride,
                                   u.buffer, u.rowStride, u.pixelStride, v.buffer, v.rowStride, v.pixelStride)
            luma = try { YuvPacking.analysisLuma(y.buffer, width, height, y.rowStride, y.pixelStride) } catch (t: Throwable) { null }
        } catch (t: Throwable) {
            request.result.complete(CaptureOutcome.Failure("The camera image could not be copied (${t.describe()})."))
            return
        } finally {
            image.close()
        }

        // Intrinsics of the CPU image exactly as stored (un-rotated, un-cropped): imageIntrinsics.
        // textureIntrinsics would describe the GPU texture, which may have another size.
        var intrinsics: Intrinsics? = null
        try {
            val k = camera.imageIntrinsics
            val f = k.focalLength; val c = k.principalPoint; val dims = k.imageDimensions
            if (f[0] > 0f && f[1] > 0f && dims[0] > 0 && dims[1] > 0) {
                val scaled = ImageGeometry.scaleIntrinsics(
                    ImageGeometry.Pinhole(f[0].toDouble(), f[1].toDouble(), c[0].toDouble(), c[1].toDouble()),
                    width.toDouble() / dims[0], height.toDouble() / dims[1])
                intrinsics = Intrinsics(scaled.fx, scaled.fy, scaled.cx, scaled.cy, source = "arcore")
            }
        } catch (_: Throwable) { }

        var iso: Int? = null
        var exposureNs: Long? = null
        var focusDiopters: Double? = null
        try {
            val meta = frame.imageMetadata
            iso = try { meta.getInt(ImageMetadata.SENSOR_SENSITIVITY) } catch (t: Throwable) { null }
            exposureNs = try { meta.getLong(ImageMetadata.SENSOR_EXPOSURE_TIME) } catch (t: Throwable) { null }
            focusDiopters = try { meta.getFloat(ImageMetadata.LENS_FOCUS_DISTANCE).toDouble().takeIf { it.isFinite() && it >= 0.0 } } catch (t: Throwable) { null }
        } catch (_: Throwable) { }

        val exif = DeviceOrientation.exifOrientation(sensorOrientation, request.deviceRotationCw)
        val trackingEpoch = epoch
        val orientationDir = rotation?.let { OrientationViewpoint.dirFromCameraQuat(it) }
        val executor = encodeExecutor
        if (executor == null) {
            request.result.complete(CaptureOutcome.Failure("AR tracking was shut down."))
            return
        }
        try {
            executor.execute {
                val outcome = try {
                    if (request.abandoned) throw IllegalStateException("capture was abandoned")
                    // The first and only encode of this image. The pixels stay in sensor orientation;
                    // how the phone was held is recorded as an EXIF orientation tag.
                    FileOutputStream(request.target).use { out ->
                        if (!YuvImage(nv21, ImageFormat.NV21, width, height, null).compressToJpeg(Rect(0, 0, width, height), JPEG_QUALITY, out))
                            throw IllegalStateException("JPEG encoder failed")
                        out.fd.sync()
                    }
                    val e = ExifInterface(request.target)
                    e.setAttribute(ExifInterface.TAG_ORIENTATION, exif.toString())
                    e.saveAttributes()
                    /*
                     * Pose: Camera.getPose(), NOT getDisplayOrientedPose(). getPose() is the pose of
                     * the physical camera in the world with OpenGL camera axes (+X right, +Y up, −Z
                     * forward) where "right" and "up" refer to the camera image in its native
                     * read-out order — i.e. to the un-rotated CPU image, which is exactly what was
                     * just stored. getDisplayOrientedPose() is rotated about the optical axis to
                     * match the current display rotation and would be wrong by 90° for a portrait
                     * UI. The capture metadata defines poses "relative to the STORED image
                     * orientation", and the EXIF tag above does not rotate pixels, so the physical
                     * pose is stored as is. The world is gravity-aligned with +Y up.
                     */
                    CaptureOutcome.Success(RawCapture(
                        file = request.target, timestampMs = timestampMs,
                        width = width, height = height, exifOrientation = exif,
                        intrinsics = intrinsics, distortion = null,
                        // Poses are only stored while ARCore is TRACKING.
                        position = if (tracking) position else null,
                        rotation = if (tracking) rotation else null,
                        trackingLost = !tracking, trackingEpoch = trackingEpoch,
                        orientationDir = if (tracking) orientationDir else null,
                        angularSpeedDegS = angular, linearSpeedMS = linear,
                        // ARCore keeps autofocus and auto-exposure running.
                        focus = FocusInfo(locked = false, distanceDiopters = focusDiopters),
                        exposure = ExposureInfo(locked = false, iso = iso, exposureNs = exposureNs),
                        analysisLuma = luma,
                    ))
                } catch (t: Throwable) {
                    request.target.delete()
                    CaptureOutcome.Failure("The photo could not be written (${t.describe()}).")
                }
                if (request.abandoned) request.target.delete()
                request.result.complete(outcome)
            }
        } catch (t: Throwable) {
            request.result.complete(CaptureOutcome.Failure("AR tracking was shut down."))
        }
    }

    private fun finish(request: CaptureRequest, outcome: CaptureOutcome) {
        pendingCapture.compareAndSet(request, null)
        request.result.complete(outcome)
    }

    private companion object {
        const val JPEG_QUALITY = 97
        const val CAPTURE_TIMEOUT_MS = 6000L
        const val AIM_TIMEOUT_MS = 2000L
        const val MAX_IMAGE_ATTEMPTS = 45
        const val ANALYSIS_EVERY_N_FRAMES = 6
        const val MAX_CONSECUTIVE_ERRORS = 30
        const val MIN_OBJECT_DISTANCE_M = 0.08f
        const val MAX_OBJECT_DISTANCE_M = 6f
    }
}
