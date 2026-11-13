package dev.pocket3d.capture

import android.app.Application
import android.os.Build
import android.os.SystemClock
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.pocket3d.capture.engine.CaptureEngine
import dev.pocket3d.capture.engine.CaptureOutcome
import dev.pocket3d.capture.engine.EngineInfo
import dev.pocket3d.capture.engine.EngineKind
import dev.pocket3d.capture.engine.EngineStatus
import dev.pocket3d.capture.engine.ExposureLocking
import dev.pocket3d.capture.engine.LiveSample
import dev.pocket3d.capture.engine.ObjectAiming
import dev.pocket3d.capture.engine.ObjectHit
import dev.pocket3d.capture.engine.RawCapture
import dev.pocket3d.capture.engine.ViewpointSource
import dev.pocket3d.capture.engine.describe
import dev.pocket3d.capture.logic.AutoCaptureDecider
import dev.pocket3d.capture.logic.AutoCaptureInput
import dev.pocket3d.capture.logic.CoverageTracker
import dev.pocket3d.capture.logic.FrameJudge
import dev.pocket3d.capture.logic.ParallaxGuard
import dev.pocket3d.capture.logic.LiveWarning
import dev.pocket3d.capture.logic.OrientationViewpoint
import dev.pocket3d.capture.logic.PanoramaDetector
import dev.pocket3d.capture.logic.PoseSample
import dev.pocket3d.capture.logic.SegmentTracker
import dev.pocket3d.capture.logic.StorageLevel
import dev.pocket3d.capture.logic.StoragePolicy
import dev.pocket3d.capture.logic.TurntableDetector
import dev.pocket3d.capture.logic.ViewContext
import dev.pocket3d.core.capture.CoverageGrid
import dev.pocket3d.core.capture.FrameAnalysis
import dev.pocket3d.core.capture.ImageGeometry
import dev.pocket3d.core.math.Quat
import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.project.CameraPose
import dev.pocket3d.core.project.CaptureSession
import dev.pocket3d.core.project.CaptureSource
import dev.pocket3d.core.project.DeviceInfo
import dev.pocket3d.core.project.Frame
import dev.pocket3d.core.project.FrameFlag
import dev.pocket3d.core.project.FrameQuality
import dev.pocket3d.core.project.TrackingInfo
import dev.pocket3d.core.services.ProjectStore
import dev.pocket3d.design.Tone
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.util.Locale
import java.util.UUID

internal enum class CoverageKind { TRACKED, ESTIMATED, MIXED, NONE }

/** Which engine the screen should run. */
internal enum class EnginePlan {
    /** Still asking ARCore whether this device is supported. */
    CHECKING,
    AR,
    CAMERA,
    /** ARCore is supported but Google Play Services for AR must be installed / updated: ask the user. */
    AR_INSTALL_PROMPT,
}

internal data class CaptureBanner(val id: String, val title: String, val body: String?, val tone: Tone)
internal data class CaptureMessage(val id: Long, val text: String)

internal data class CaptureUiState(
    val loading: Boolean = true,
    /** The session cannot be used at all; only "back" is offered. */
    val fatal: String? = null,
    val sessionId: String? = null,
    val plan: EnginePlan = EnginePlan.CHECKING,
    /** ARCore is installed and usable, so the user can switch between the engines. */
    val arUsable: Boolean = false,
    /** The ARCore availability check gave no answer; the user may ask again. */
    val arCheckInconclusive: Boolean = false,
    val engineKind: EngineKind? = null,
    val engineStatus: EngineStatus = EngineStatus.Starting,
    val engineInfo: EngineInfo = EngineInfo(),
    val photoCount: Int = 0,
    val canUndo: Boolean = false,
    val lastFrame: Frame? = null,
    val lastFrameFile: File? = null,
    /** counts[band][azimuthSector], filled only from stored photos. */
    val coverage: List<List<Int>> = List(CoverageGrid.BANDS) { List(CoverageGrid.AZIMUTH_BINS) { 0 } },
    val coverageKind: CoverageKind = CoverageKind.NONE,
    /** Photos whose viewpoint is unknown and therefore not in the ring. */
    val photosWithoutViewpoint: Int = 0,
    val guidance: String = "",
    val segmentCount: Int = 0,
    val autoCapture: Boolean = false,
    val autoAvailable: Boolean = false,
    val objectSet: Boolean = false,
    val settingObject: Boolean = false,
    val busy: Boolean = false,
    /** A manually taken weak photo waiting for "Keep anyway" / "Discard": the problems, one per line. */
    val pendingReasons: List<String>? = null,
    val storage: StorageLevel = StorageLevel.OK,
    val freeBytes: Long? = null,
    val banners: List<CaptureBanner> = emptyList(),
    val message: CaptureMessage? = null,
    /** Incremented for every photo that was stored: drives the flash and the haptic tick. */
    val storedTick: Int = 0,
)

/** Fast-changing part of the UI (10 Hz), kept apart so it does not recompose the whole screen. */
internal data class CaptureLiveUi(
    /** Current viewpoint (azimuth°, elevation°), or null when unknown. */
    val viewpoint: Pair<Double, Double>? = null,
    val viewpointTracked: Boolean = false,
    val warnings: List<LiveWarning> = emptyList(),
    val autoHint: String? = null,
    val trackingOk: Boolean = false,
    val trackingLabel: String? = null,
    val trackingAdvice: String? = null,
)

/**
 * State holder of the capture screen. Owns everything that must survive rotation: the session,
 * the photos already stored, viewpoint coverage, tracking segments and the capture decisions.
 * The camera engines live in the composition (they need views and a lifecycle) and are attached
 * and detached here.
 *
 * A photo is counted only after `ProjectStore.commitFrame` returned; a failed commit is reported
 * and counts nothing.
 */
internal class CaptureViewModel(
    app: Application,
    private val projectId: String,
    initialSessionId: String?,
) : AndroidViewModel(app) {
    private val store: ProjectStore? = reviewStoreOrNull()

    private val _ui = MutableStateFlow(CaptureUiState(sessionId = initialSessionId))
    val ui: StateFlow<CaptureUiState> = _ui.asStateFlow()
    private val _live = MutableStateFlow(CaptureLiveUi())
    val live: StateFlow<CaptureLiveUi> = _live.asStateFlow()

    /** Physical device rotation (0/90/180/270), fed by the screen's OrientationEventListener. */
    @Volatile var deviceRotationCw: Int = 0

    private var sessionId: String? = initialSessionId
    private var frames: List<Frame> = emptyList()
    private val coverage = CoverageTracker()
    /** Orientation-estimate mode only: image-based check for "turning on the spot" (no position tracking there). */
    private var liveFocalPx: Float? = null
    private val parallax = ParallaxGuard { liveFocalPx }
    private var segments = SegmentTracker()
    private val poseSamples = LinkedHashMap<String, PoseSample>()
    private val hashes = LinkedHashMap<String, Long>()
    private val takenThisRun = ArrayList<String>()
    /** Frame ids that the store's observation has already shown (see [onSessionObserved]). */
    private val seenInStore = HashSet<String>()
    private var restoredMode: String = "none"

    private var engine: CaptureEngine? = null
    private var engineJob: Job? = null
    private var observeJob: Job? = null
    private var lastEpoch = 0
    /** Object centre in the CURRENT tracking segment's coordinates; null if unknown there. */
    private var liveCenter: Vec3? = null
    /** Last centre written to the session (`object_center_ar`). */
    private var storedCenter: List<Double>? = null

    private var plan = EnginePlan.CHECKING
    private var arUsable = false
    private var arCheckInconclusive = false
    private var autoUserChoice: Boolean? = null
    private var armed = false
    private var busy = false
    private var settingObject = false
    private var pending: Pending? = null
    private var lastCaptureAtMs = 0L
    private var lastLiveUiAtMs = 0L
    /** After auto capture skipped a weak frame: do not try again before this time, and say why. */
    private var autoHoldUntilMs = 0L
    private var autoSkipNote: String? = null
    private var storage = StorageLevel.OK
    private var freeBytes: Long? = null
    private var lastStorageCheckMs = 0L
    private var loading = true
    private var fatal: String? = null
    private val banners = LinkedHashMap<String, CaptureBanner>()
    private val suppressedBanners = HashSet<String>()
    private var message: CaptureMessage? = null
    private var messageSeq = 0L
    private var storedTick = 0
    private val sidecarMutex = Mutex()

    private class Pending(
        val raw: RawCapture, val frame: Frame,
        val dir: Vec3?, val tracked: Boolean, val center: Vec3?, val hash: Long?,
    )

    init {
        viewModelScope.launch {
            load()
            loading = false
            publish()
            if (fatal == null) planEngine()
        }
    }

    // =================================================================================================
    // Session loading / restoring
    // =================================================================================================

    private suspend fun load() {
        val store = store
        if (store == null) {
            fatal = "Project storage is not available."
            return
        }
        refreshStorage(force = true)
        val sid = sessionId ?: return
        val session = try { store.session(projectId, sid) } catch (t: Throwable) { null }
        if (session == null) {
            fatal = "This capture session could not be opened. It may have been deleted."
            return
        }
        restore(session)
        observe(sid)
    }

    /**
     * Continues a stored session (after leaving the screen or after process death): counts and
     * coverage come from the stored photos, and whatever is tracked from now on goes into a new
     * tracking segment.
     */
    private suspend fun restore(session: CaptureSession) {
        frames = session.frames
        seenInStore += frames.map { it.id }
        segments = SegmentTracker(session.tracking.segments)
        restoredMode = session.tracking.mode
        storedCenter = session.objectCenterAr
        val saved = ViewpointSidecar.load(getApplication(), projectId, session.id)
        val center = session.objectCenterAr?.takeIf { it.size == 3 }?.let { Vec3(it[0].toFloat(), it[1].toFloat(), it[2].toFloat()) }
        coverage.clear()
        for (f in frames) {
            val s = saved[f.id]
            val pose = f.pose
            when {
                s != null -> coverage.restore(f.id, Vec3(s.x, s.y, s.z), s.tracked)
                pose != null && pose.t.size == 3 && pose.q.size == 4 -> {
                    // No recorded viewpoint (older data): derive it from the stored pose.
                    val p = Vec3(pose.t[0].toFloat(), pose.t[1].toFloat(), pose.t[2].toFloat())
                    val q = Quat(pose.q[0].toFloat(), pose.q[1].toFloat(), pose.q[2].toFloat(), pose.q[3].toFloat())
                    val dir = OrientationViewpoint.dirFromCameraQuat(q)
                    if (center != null && p.distanceTo(center) >= CoverageTracker.MIN_CENTER_DISTANCE_M) {
                        coverage.restore(f.id, p - center, tracked = true)
                    } else coverage.restore(f.id, dir, tracked = false)
                }
            }
        }
        if (frames.isNotEmpty()) {
            banners["restored"] = CaptureBanner(
                "restored", "Continuing a capture with ${frames.size} photo${if (frames.size == 1) "" else "s"}",
                "Coverage of the earlier photos is shown as it was recorded. Positions tracked from now on start a " +
                    "new tracking segment, so their sectors may be rotated relative to the earlier ones — the " +
                    "reconstruction aligns all photos itself.",
                Tone.Neutral)
        }
    }

    private fun observe(sid: String) {
        val store = store ?: return
        observeJob?.cancel()
        observeJob = viewModelScope.launch {
            try {
                store.observeSession(projectId, sid).collect { onSessionObserved(it) }
            } catch (c: CancellationException) {
                throw c
            } catch (_: Throwable) {
                // Observation is a convenience (photos deleted in the review screen); capture works without it.
            }
        }
    }

    /** The stored session changed (e.g. photos were deleted in the review screen). */
    private fun onSessionObserved(session: CaptureSession?) {
        if (session == null) return
        val present = session.frames.map { it.id }.toSet()
        seenInStore += present
        // A photo that was committed a moment ago may not be in this (older) snapshot yet: only
        // drop photos the store has shown before and no longer has.
        val gone = (frames.map { it.id } + coverage.entries().map { it.frameId }).filter { it in seenInStore && it !in present }.toSet()
        val known = frames.map { it.id }.toSet()
        frames = session.frames + frames.filter { it.id !in present && it.id !in seenInStore }
        if (gone.isNotEmpty()) {
            val keep = (known + present) - gone
            coverage.retain(coverage.entries().map { it.frameId }.filter { it !in gone }.toSet())
            segments.retain(keep)
            poseSamples.keys.removeAll(gone)
            hashes.keys.removeAll(gone)
            takenThisRun.removeAll(gone)
            saveSidecar()
        }
        publish()
    }

    // =================================================================================================
    // Engine choice
    // =================================================================================================

    /** Asks ARCore again after an inconclusive availability check. */
    fun retryArCheck() {
        if (!arCheckInconclusive) return
        viewModelScope.launch { planEngine() }
    }

    private suspend fun planEngine() {
        arCheckInconclusive = false
        when (CapabilityProbe.arAvailability(getApplication())) {
            ArCoreAvailability.SUPPORTED_INSTALLED -> { arUsable = true; plan = EnginePlan.AR; banners.remove("engine") }
            ArCoreAvailability.SUPPORTED_NEEDS_INSTALL -> plan = EnginePlan.AR_INSTALL_PROMPT
            ArCoreAvailability.UNSUPPORTED -> {
                plan = EnginePlan.CAMERA
                engineNote("Positions are not tracked on this phone",
                           "This phone is not certified for ARCore motion tracking. Photos are taken at full " +
                               "resolution and viewpoint coverage is estimated from the phone's orientation.")
            }
            ArCoreAvailability.UNKNOWN -> {
                plan = EnginePlan.CAMERA
                arCheckInconclusive = true
                engineNote("AR support could not be checked",
                           "Google Play Services for AR did not answer, so positions are not tracked. Photos are " +
                               "taken at full resolution and viewpoint coverage is estimated from the phone's orientation.")
            }
        }
        publish()
    }

    private fun engineNote(title: String, body: String, tone: Tone = Tone.Neutral) {
        banners["engine"] = CaptureBanner("engine", title, body, tone)
    }

    /** ARCore finished installing / updating. */
    fun onArInstalled() {
        arUsable = true
        plan = EnginePlan.AR
        banners.remove("engine")
        publish()
    }

    /** The user chose not to install AR support, or the installation failed. */
    fun onArInstallDeclined(reason: String) {
        plan = EnginePlan.CAMERA
        engineNote("Continuing without AR tracking", reason)
        publish()
    }

    /** ARCore could not start or stopped working: fall back to the photo engine and say why. */
    fun onArFailed(reason: String) {
        arUsable = false
        plan = EnginePlan.CAMERA
        engineNote("AR tracking is not available",
                   "$reason Photos are taken with the camera directly; viewpoint coverage is estimated from the phone's orientation.",
                   Tone.Warn)
        publish()
    }

    /** User switch between "AR tracked" and "High-resolution photos". */
    fun switchEngine(toAr: Boolean) {
        if (toAr && !arUsable) return
        plan = if (toAr) EnginePlan.AR else EnginePlan.CAMERA
        if (toAr) banners.remove("engine")
        else engineNote("High-resolution photos",
                        "Photos use the camera's full resolution. Positions are not tracked in this mode: viewpoint " +
                            "coverage is estimated from the phone's orientation.")
        publish()
    }

    fun attach(e: CaptureEngine) {
        if (engine === e) return
        engineJob?.cancel()
        engine = e
        armed = false
        lastEpoch = 0
        liveCenter = null
        if (e.kind == EngineKind.AR) segments.onSessionRecreated()
        engineJob = viewModelScope.launch {
            launch { e.live.collect { onLive(e, it) } }
            launch { e.status.collect { publish() } }
            launch { e.info.collect { publish() } }
        }
        publish()
    }

    fun detach(e: CaptureEngine) {
        if (engine !== e) return
        engineJob?.cancel()
        engineJob = null
        engine = null
        _live.value = CaptureLiveUi()
        publish()
    }

    // =================================================================================================
    // Live samples: tracking segments, warnings, auto capture
    // =================================================================================================

    private fun onLive(e: CaptureEngine, s: LiveSample) {
        if (engine !== e) return
        val ar = e.kind == EngineKind.AR
        if (ar) {
            syncEpoch(s.trackingEpoch, s.trackingOk)
            val c = s.objectCenter
            val prev = liveCenter
            if (c != null && s.trackingOk && (prev == null || prev.distanceTo(c) > CENTER_UPDATE_M)) {
                liveCenter = c
                coverage.recenter(c, segments.current)
                persistMeta()
                saveSidecar()
                publish()
            }
        }
        val now = SystemClock.elapsedRealtime()
        val view = currentView(e, s.trackingOk, s.position, s.orientationDir)
        val nearest = view?.let { coverage.nearestAngleDeg(it.first) }
        val since = if (lastCaptureAtMs == 0L) Long.MAX_VALUE / 4 else now - lastCaptureAtMs
        val autoOn = autoEnabled(e)
        var parallaxHold = false
        if (!ar) {
            liveFocalPx = s.analysisFocalPx
            parallax.onSample(s.orientationDir, s.centreShiftX, s.centreShiftY, s.centreShiftValid, s.centreShiftFrames,
                              s.analysisWidth)
            parallaxHold = parallax.holdAutoCapture()
        }
        val decision = AutoCaptureDecider.decide(AutoCaptureInput(
            enabled = autoOn && !parallaxHold && pending == null && now >= autoHoldUntilMs && e.status.value is EngineStatus.Running,
            armed = armed, trackingRequired = ar, trackingOk = s.trackingOk,
            nearestKeptDeg = nearest, angularSpeedDegS = s.angularSpeedDegS, linearSpeedMS = s.linearSpeedMS,
            liveFlags = s.liveFlags, busy = busy, storageBlocked = storage == StorageLevel.BLOCKED,
            msSinceLastCapture = since))
        if (decision.fire) capture(manual = false)

        if (now - lastLiveUiAtMs >= LIVE_UI_INTERVAL_MS) {
            lastLiveUiAtMs = now
            val ctx = ViewContext(nearestKeptDeg = nearest, angularSpeedDegS = s.angularSpeedDegS, linearSpeedMS = s.linearSpeedMS)
            _live.value = CaptureLiveUi(
                viewpoint = view?.let { OrientationViewpoint.azimuthElevation(it.first) },
                viewpointTracked = view?.second == true,
                warnings = FrameJudge.liveWarnings(s.liveFlags, ctx, since),
                autoHint = when {
                    !autoOn || pending != null -> null
                    parallaxHold -> "Auto capture paused — the picture slides as if the phone were only turning. Walk around the object."
                    now < autoHoldUntilMs -> autoSkipNote
                    else -> decision.hint
                },
                trackingOk = s.trackingOk, trackingLabel = s.trackingLabel, trackingAdvice = s.trackingAdvice,
            )
        }
    }

    /** Keeps [segments] in step with the engine's tracking-loss counter. */
    private fun syncEpoch(epoch: Int, trackingOk: Boolean) {
        if (epoch != lastEpoch) {
            lastEpoch = epoch
            segments.onTracking(false)
        }
        if (trackingOk && segments.onTracking(true)) {
            // The centre was expressed in the old segment's coordinates; it comes back only when
            // ARCore reports the anchor as tracked again, or when the user sets it again.
            liveCenter = null
            say("Tracking recovered — positions before/after are aligned later by the reconstruction, not assumed.")
            publish()
        }
    }

    /** Current viewpoint direction and whether it is tracked (true) or an orientation estimate (false). */
    private fun currentView(e: CaptureEngine, trackingOk: Boolean, position: Vec3?, orientationDir: Vec3?): Pair<Vec3, Boolean>? {
        if (e.kind == EngineKind.AR) {
            if (!trackingOk) return null
            val c = liveCenter
            if (c != null && position != null && position.distanceTo(c) >= CoverageTracker.MIN_CENTER_DISTANCE_M)
                return (position - c).normalized() to true
        }
        return orientationDir?.let { it to false }
    }

    private fun autoEnabled(e: CaptureEngine): Boolean {
        if (!autoAvailable(e)) return false
        // Default: on with AR tracking, off with the orientation estimate (the user can turn it on).
        return autoUserChoice ?: (e.kind == EngineKind.AR)
    }

    private fun autoAvailable(e: CaptureEngine): Boolean =
        e.kind == EngineKind.AR || e.info.value.viewpointSource == ViewpointSource.IMU

    fun toggleAuto() {
        val e = engine ?: return
        if (!autoAvailable(e)) {
            say("Auto capture needs AR tracking or an orientation sensor. This phone has neither — use the shutter.")
            return
        }
        autoUserChoice = !autoEnabled(e)
        publish()
    }

    // =================================================================================================
    // Capture
    // =================================================================================================

    fun onShutter() {
        if (pending != null) return
        armed = true
        capture(manual = true)
    }

    private fun capture(manual: Boolean) {
        val e = engine ?: return
        if (busy || pending != null) return
        if (e.status.value !is EngineStatus.Running) {
            if (manual) say("The camera is not ready.")
            return
        }
        busy = true
        if (manual) publish()
        viewModelScope.launch {
            try {
                refreshStorage(force = false)
                if (storage == StorageLevel.BLOCKED) {
                    if (manual) say("Storage is almost full (${freeBytes?.let(::formatBytes) ?: "unknown"} free). Free up space to continue.")
                    return@launch
                }
                val store = store ?: return@launch
                val sid = ensureSession(e) ?: return@launch
                val temp = try {
                    store.newFrameTempFile(projectId, sid)
                } catch (t: Throwable) {
                    say("The photo could not be prepared: ${t.describe()}")
                    return@launch
                }
                when (val outcome = e.capture(temp, deviceRotationCw)) {
                    is CaptureOutcome.Failure -> {
                        temp.delete()
                        if (manual) say(outcome.message)
                    }
                    is CaptureOutcome.Success -> onCaptured(e, outcome.raw, manual)
                }
            } catch (c: CancellationException) {
                throw c
            } catch (t: Throwable) {
                say("Capture failed: ${t.describe()}")
            } finally {
                busy = false
                lastCaptureAtMs = SystemClock.elapsedRealtime()
                publish()
            }
        }
    }

    private suspend fun ensureSession(e: CaptureEngine): String? {
        sessionId?.let { return it }
        val store = store ?: return null
        return try {
            val source = if (e.kind == EngineKind.AR) CaptureSource.CAMERA_AR else CaptureSource.CAMERA
            val session = store.createSession(projectId, source,
                DeviceInfo(Build.MANUFACTURER.orEmpty(), Build.MODEL.orEmpty(), Build.VERSION.SDK_INT))
            sessionId = session.id
            observe(session.id)
            session.id
        } catch (t: Throwable) {
            say("A capture session could not be created: ${t.describe()}")
            null
        }
    }

    private suspend fun onCaptured(e: CaptureEngine, raw: RawCapture, manual: Boolean) {
        val ar = e.kind == EngineKind.AR
        if (ar) syncEpoch(raw.trackingEpoch, !raw.trackingLost)
        val tracked = raw.position != null && raw.rotation != null

        // Viewpoint of this photo: tracked position relative to the object when both are known in
        // the current segment, otherwise the orientation estimate, otherwise unknown.
        val center = liveCenter
        var dir: Vec3? = null
        var dirTracked = false
        if (tracked && center != null && raw.position!!.distanceTo(center) >= CoverageTracker.MIN_CENTER_DISTANCE_M) {
            dir = (raw.position - center).normalized(); dirTracked = true
        } else if (raw.orientationDir != null && !raw.trackingLost) {
            dir = raw.orientationDir
        }

        var quality = FrameQuality()
        var imageFlags: List<String> = emptyList()
        var hash: Long? = null
        raw.analysisLuma?.let { (luma, w, h) ->
            withContext(Dispatchers.Default) {
                val (q, f) = FrameAnalysis.analyze(luma, w, h)
                quality = q; imageFlags = f
                hash = FrameAnalysis.dHash(luma, w, h)
            }
        }
        val previousHash = hashes.values.lastOrNull()
        val ctx = ViewContext(
            nearestKeptDeg = dir?.let { coverage.nearestAngleDeg(it) },
            angularSpeedDegS = raw.angularSpeedDegS, linearSpeedMS = raw.linearSpeedMS,
            trackingLost = raw.trackingLost,
            hashDistanceToPrevious = if (hash != null && previousHash != null) FrameAnalysis.hammingDistance(hash!!, previousHash) else null,
        )
        val (judged, flags) = FrameJudge.judge(quality, imageFlags, ctx)

        val id = UUID.randomUUID().toString().replace("-", "").substring(0, 16)
        val frame = Frame(
            id = id,
            name = String.format(Locale.US, "capture_%04d.jpg", frames.size + 1),
            file = "",
            timestampMs = raw.timestampMs,
            width = raw.width, height = raw.height, exifOrientation = raw.exifOrientation,
            intrinsics = raw.intrinsics, distortion = raw.distortion,
            pose = if (tracked) CameraPose(
                t = listOf(raw.position!!.x.toDouble(), raw.position.y.toDouble(), raw.position.z.toDouble()),
                q = raw.rotation!!.let { listOf(it.x.toDouble(), it.y.toDouble(), it.z.toDouble(), it.w.toDouble()) },
                segment = segments.current) else null,
            focus = raw.focus, exposure = raw.exposure,
            quality = judged, flags = flags, format = "jpeg",
        )
        val p = Pending(raw, frame, dir, dirTracked, if (dirTracked) center else null, hash)

        // "Tracking lost" alone is no surprise (the screen says so while it happens): no prompt.
        val weak = flags.any { it != FrameFlag.TRACKING_LOST }
        when {
            !weak -> commit(p)
            manual -> { pending = p; publish() }
            else -> {
                // Auto capture simply skips weak frames (and waits a moment before the next try).
                raw.file.delete()
                autoHoldUntilMs = SystemClock.elapsedRealtime() + AUTO_SKIP_HOLD_MS
                autoSkipNote = "Skipped a weak frame: " + FrameFlag.describe(flags.first { it != FrameFlag.TRACKING_LOST })
            }
        }
    }

    fun keepPending() {
        val p = pending ?: return
        pending = null
        busy = true
        publish()
        viewModelScope.launch {
            try { commit(p) } finally { busy = false; publish() }
        }
    }

    fun discardPending() {
        val p = pending ?: return
        pending = null
        p.raw.file.delete()
        publish()
    }

    /** Stores the photo. Only after `commitFrame` returned does it count anywhere. */
    private suspend fun commit(p: Pending) {
        val store = store ?: return
        val sid = sessionId ?: return
        val stored = try {
            store.commitFrame(projectId, sid, p.frame, p.raw.file)
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            p.raw.file.delete()
            refreshStorage(force = true)
            say("The photo could not be saved and was not counted: ${t.describe()}")
            return
        }
        frames = frames.filter { it.id != stored.id } + stored
        takenThisRun += stored.id
        p.hash?.let { hashes[stored.id] = it }
        val raw = p.raw
        val pose = stored.pose
        if (pose != null && raw.position != null && raw.rotation != null) {
            segments.addFrame(stored.id, pose.segment)
            val orientationDir = OrientationViewpoint.dirFromCameraQuat(raw.rotation)
            when {
                p.tracked && p.center != null -> coverage.addTracked(stored.id, raw.position, p.center, pose.segment, orientationDir)
                else -> coverage.addEstimated(stored.id, p.dir ?: orientationDir, raw.position, pose.segment)
            }
            poseSamples[stored.id] = PoseSample(raw.position, ImageGeometry.forward(raw.rotation), pose.segment, p.hash)
            runMotionDetectors()
        } else if (p.dir != null) {
            coverage.addEstimated(stored.id, p.dir)
            // No position tracking in this mode: judge parallax from the picture itself.
            parallax.onCapture()
            raise("panorama", parallax.turningInPlace) {
                CaptureBanner("panorama", "It looks like you are turning on the spot",
                    "Between the last photos the whole picture slid sideways the way it does when the phone only " +
                        "rotates. The coverage ring cannot tell this apart from walking around the object — it only " +
                        "knows the phone's direction. Photos taken from one spot cannot be turned into a 3D model: " +
                        "walk around the object and keep it in the centre of the frame.",
                    Tone.Warn)
            }
        }
        storedTick++
        publish()
        persistMeta()
        saveSidecar()
        refreshStorage(force = false)
    }

    private fun runMotionDetectors() {
        val samples = poseSamples.values.toList()
        raise("panorama", PanoramaDetector.isTurningInPlace(samples)) {
            CaptureBanner("panorama", "You seem to be turning on the spot",
                "The last photos were taken from almost the same place while the phone rotated. That makes a " +
                    "panorama, not a 3D view. Walk around the object and keep it in the centre of the frame.",
                Tone.Warn)
        }
        raise("turntable", TurntableDetector.detect(samples)) {
            CaptureBanner("turntable", "The object seems to move while the phone stays still",
                "The phone did not move between the last photos, yet the picture changed. Turning the object — by " +
                    "hand or on a turntable — in front of a static background cannot be reconstructed. Leave the " +
                    "object where it is and move the phone around it.",
                Tone.Bad)
        }
    }

    /** Shows a detector banner while its condition holds; a dismissed banner returns only after the condition cleared once. */
    private inline fun raise(id: String, active: Boolean, banner: () -> CaptureBanner) {
        if (!active) {
            suppressedBanners.remove(id)
            banners.remove(id)
        } else if (id !in suppressedBanners) banners[id] = banner()
    }

    fun undoLast() {
        val store = store ?: return
        val sid = sessionId ?: return
        val id = takenThisRun.lastOrNull() ?: return
        if (busy) return
        busy = true
        publish()
        viewModelScope.launch {
            try {
                store.removeFrame(projectId, sid, id)
                frames = frames.filter { it.id != id }
                takenThisRun.remove(id)
                coverage.remove(id)
                segments.removeFrame(id)
                poseSamples.remove(id)
                hashes.remove(id)
                runMotionDetectors()
                persistMeta()
                saveSidecar()
                refreshStorage(force = true)
                say("Last photo removed.")
            } catch (c: CancellationException) {
                throw c
            } catch (t: Throwable) {
                say("The photo could not be removed: ${t.describe()}")
            } finally {
                busy = false
                publish()
            }
        }
    }

    // =================================================================================================
    // Object centre and lock
    // =================================================================================================

    fun setObject() {
        val aiming = engine as? ObjectAiming ?: return
        if (settingObject) return
        settingObject = true
        publish()
        viewModelScope.launch {
            try {
                when (val hit = aiming.setObjectAtReticle()) {
                    is ObjectHit.Found -> {
                        liveCenter = hit.center
                        coverage.recenter(hit.center, segments.current)
                        persistMeta()
                        saveSidecar()
                        say(String.format(Locale.US, "Object set on %s, %.2f m away. Coverage is now tracked around it.",
                                          hit.surface, hit.distanceM))
                    }
                    is ObjectHit.Missed -> say(hit.reason)
                }
            } catch (c: CancellationException) {
                throw c
            } catch (t: Throwable) {
                say("The object could not be set: ${t.describe()}")
            } finally {
                settingObject = false
                publish()
            }
        }
    }

    fun setLock(lock: Boolean) {
        (engine as? ExposureLocking)?.setLock(lock)
    }

    // =================================================================================================
    // Persistence helpers
    // =================================================================================================

    private fun trackingInfo(): TrackingInfo {
        val segs = segments.snapshot()
        // What the stored photos actually have: AR poses, orientation estimates, or nothing.
        val current = when {
            segs.isNotEmpty() -> "arcore"
            coverage.estimatedCount > 0 -> "imu"
            else -> "none"
        }
        fun rank(m: String) = when (m) { "arcore" -> 2; "imu" -> 1; else -> 0 }
        // Keep what an earlier run recorded (e.g. "imu" when its viewpoint estimates were lost),
        // but never claim AR tracking without a tracked photo.
        val keepRestored = rank(restoredMode) > rank(current) && restoredMode != "arcore"
        return TrackingInfo(mode = if (keepRestored) restoredMode else current, segments = segs)
    }

    private fun persistMeta() {
        val store = store ?: return
        val sid = sessionId ?: return
        val center = liveCenter?.let { listOf(it.x.toDouble(), it.y.toDouble(), it.z.toDouble()) } ?: storedCenter
        storedCenter = center
        val tracking = trackingInfo()
        viewModelScope.launch(NonCancellable) {
            try {
                store.updateSessionMeta(projectId, sid, tracking, center)
            } catch (t: Throwable) {
                say("Tracking information could not be saved: ${t.describe()}")
            }
        }
    }

    private fun saveSidecar() {
        val sid = sessionId ?: return
        val entries = coverage.entries().map { ViewpointSidecar.Entry(it.frameId, it.dir.x, it.dir.y, it.dir.z, it.tracked) }
        viewModelScope.launch(NonCancellable) {
            sidecarMutex.withLock { ViewpointSidecar.save(getApplication(), projectId, sid, entries) }
        }
    }

    private suspend fun refreshStorage(force: Boolean) {
        val store = store ?: return
        val now = SystemClock.elapsedRealtime()
        if (!force && now - lastStorageCheckMs < STORAGE_CHECK_INTERVAL_MS && storage == StorageLevel.OK) return
        lastStorageCheckMs = now
        val free = try { store.freeBytes() } catch (t: Throwable) { return }
        freeBytes = free
        storage = StoragePolicy.level(free)
        when (storage) {
            StorageLevel.OK -> banners.remove("storage")
            StorageLevel.LOW -> banners["storage"] = CaptureBanner("storage", "Storage is running low",
                "${formatBytes(free)} free. Capture stops below ${formatBytes(StoragePolicy.BLOCK_BYTES)} so that no photo is lost half-written.",
                Tone.Warn)
            StorageLevel.BLOCKED -> banners["storage"] = CaptureBanner("storage", "Not enough storage to take photos",
                "Only ${formatBytes(free)} free. Free up at least ${formatBytes(StoragePolicy.BLOCK_BYTES)} on the phone, then come back. " +
                    "Photos already taken are safe.",
                Tone.Bad)
        }
    }

    /** Called when the screen returns to the foreground. */
    fun onResume() {
        viewModelScope.launch { refreshStorage(force = true); publish() }
    }

    fun dismissBanner(id: String) {
        if (id == "storage" && storage == StorageLevel.BLOCKED) return
        banners.remove(id)
        suppressedBanners += id
        publish()
    }

    fun messageShown(id: Long) {
        if (message?.id == id) { message = null; publish() }
    }

    private fun say(text: String) {
        message = CaptureMessage(++messageSeq, text)
        publish()
    }

    override fun onCleared() {
        pending?.raw?.file?.delete()
        pending = null
        super.onCleared()
    }

    // =================================================================================================
    // UI state
    // =================================================================================================

    private fun publish() {
        val e = engine
        val info = e?.info?.value ?: EngineInfo()
        val tracked = coverage.trackedCount
        val estimated = coverage.estimatedCount
        val kind = when {
            tracked > 0 && estimated > 0 -> CoverageKind.MIXED
            tracked > 0 -> CoverageKind.TRACKED
            estimated > 0 -> CoverageKind.ESTIMATED
            // Nothing stored yet: say what the next photo will be.
            e?.kind == EngineKind.AR -> if (liveCenter != null) CoverageKind.TRACKED else CoverageKind.ESTIMATED
            info.viewpointSource == ViewpointSource.IMU -> CoverageKind.ESTIMATED
            e == null -> if (frames.isEmpty()) CoverageKind.ESTIMATED else CoverageKind.NONE
            else -> CoverageKind.NONE
        }
        val last = frames.lastOrNull()
        val lastFile = if (last != null && sessionId != null) {
            try { store?.frameFile(projectId, sessionId!!, last) } catch (t: Throwable) { null }
        } else null
        val guidance = when {
            kind == CoverageKind.NONE && coverage.size == 0 ->
                "Move around the object in small steps and take a photo every step."
            else -> coverage.grid.guidance().firstOrNull() ?: "All sides have photos. Check the review before you finish."
        }
        _ui.update {
            it.copy(
                loading = loading, fatal = fatal, sessionId = sessionId,
                plan = plan, arUsable = arUsable, arCheckInconclusive = arCheckInconclusive,
                engineKind = e?.kind, engineStatus = e?.status?.value ?: EngineStatus.Starting, engineInfo = info,
                photoCount = frames.size, canUndo = takenThisRun.isNotEmpty(),
                lastFrame = last, lastFrameFile = lastFile,
                coverage = coverage.counts(), coverageKind = kind,
                photosWithoutViewpoint = (frames.size - coverage.size).coerceAtLeast(0),
                guidance = guidance,
                segmentCount = segments.segmentCount,
                autoCapture = e != null && autoEnabled(e), autoAvailable = e != null && autoAvailable(e),
                objectSet = liveCenter != null, settingObject = settingObject,
                busy = busy,
                pendingReasons = pending?.let { p -> FrameJudge.describe(p.frame.flags) },
                storage = storage, freeBytes = freeBytes,
                banners = banners.values.toList(), message = message, storedTick = storedTick,
            )
        }
    }

    private companion object {
        const val LIVE_UI_INTERVAL_MS = 100L
        const val AUTO_SKIP_HOLD_MS = 1500L
        const val STORAGE_CHECK_INTERVAL_MS = 15_000L
        /** The anchored object centre is followed when it moves by more than this. */
        const val CENTER_UPDATE_M = 0.03f
    }
}

/**
 * Viewpoint directions of the stored photos, kept next to the app's private data so coverage can
 * be restored exactly after a restart. This is UI state only: orientation-estimated viewpoints
 * have no place in the capture metadata (which carries real AR poses only), and nothing here is
 * ever uploaded.
 */
internal object ViewpointSidecar {
    @Serializable
    data class Entry(val id: String, val x: Float, val y: Float, val z: Float, val tracked: Boolean)

    @Serializable
    private data class Document(val format: Int = 1, val entries: List<Entry> = emptyList())

    private val json = Json { ignoreUnknownKeys = true }

    private fun file(app: Application, projectId: String, sessionId: String): File {
        fun safe(s: String) = s.replace(Regex("[^A-Za-z0-9_-]"), "_").take(64)
        return File(File(app.filesDir, "capture_viewpoints"), "${safe(projectId)}__${safe(sessionId)}.json")
    }

    suspend fun load(app: Application, projectId: String, sessionId: String): Map<String, Entry> = withContext(Dispatchers.IO) {
        try {
            val f = file(app, projectId, sessionId)
            if (!f.isFile) emptyMap()
            else json.decodeFromString(Document.serializer(), f.readText()).entries.associateBy { it.id }
        } catch (t: Throwable) {
            emptyMap()
        }
    }

    suspend fun save(app: Application, projectId: String, sessionId: String, entries: List<Entry>) = withContext(Dispatchers.IO) {
        try {
            val f = file(app, projectId, sessionId)
            f.parentFile?.mkdirs()
            val tmp = File(f.parentFile, f.name + ".tmp")
            tmp.writeText(json.encodeToString(Document.serializer(), Document(entries = entries)))
            if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
        } catch (_: Throwable) {
            // Losing this file only loses the coverage display of estimated viewpoints after a restart.
        }
        Unit
    }
}
