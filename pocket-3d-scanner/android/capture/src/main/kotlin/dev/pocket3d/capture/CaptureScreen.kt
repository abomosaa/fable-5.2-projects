package dev.pocket3d.capture

import android.app.Activity
import android.app.Application
import android.content.pm.ActivityInfo
import android.opengl.GLSurfaceView
import android.view.HapticFeedbackConstants
import android.view.OrientationEventListener
import androidx.activity.compose.BackHandler
import androidx.camera.view.PreviewView
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.LockOpen
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.MyLocation
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.google.ar.core.ArCoreApk
import com.google.ar.core.exceptions.UnavailableDeviceNotCompatibleException
import com.google.ar.core.exceptions.UnavailableUserDeclinedInstallationException
import dev.pocket3d.capture.engine.ArEngine
import dev.pocket3d.capture.engine.CameraXEngine
import dev.pocket3d.capture.engine.EngineKind
import dev.pocket3d.capture.engine.EngineStatus
import dev.pocket3d.capture.engine.ViewpointSource
import dev.pocket3d.capture.engine.describe
import dev.pocket3d.capture.logic.DeviceOrientation
import dev.pocket3d.capture.logic.StorageLevel
import dev.pocket3d.design.InfoBanner
import dev.pocket3d.design.NumericStyle
import dev.pocket3d.design.P3
import dev.pocket3d.design.Pocket3DTheme
import dev.pocket3d.design.StatusPill
import dev.pocket3d.design.Tone

/**
 * Guided capture. One UI over two engines, chosen from what the device can really do:
 * ARCore-tracked capture where ARCore is available, otherwise CameraX photos with a viewpoint
 * estimate from the orientation sensor. Photos are committed to the project store one by one.
 *
 * @param sessionId an existing capture session to continue, or null to start a new one (the
 *   session is created when the first photo is taken)
 * @param onFinished called with the session id when the user is done (at least one photo exists)
 */
@Composable
fun CaptureScreen(
    projectId: String,
    sessionId: String?,
    onFinished: (sessionId: String) -> Unit,
    onBack: () -> Unit,
    onImportInstead: () -> Unit,
) {
    CapturePermissionGate(onBack = onBack, onImportInstead = onImportInstead) {
        CaptureContent(projectId, sessionId, onFinished, onBack, onImportInstead)
    }
}

@Composable
private fun CaptureContent(
    projectId: String,
    sessionId: String?,
    onFinished: (String) -> Unit,
    onBack: () -> Unit,
    onImportInstead: () -> Unit,
) {
    val context = LocalContext.current
    val app = context.applicationContext as Application
    // A session created on this screen is remembered across process death, so reopening continues it.
    var savedSessionId by rememberSaveable { mutableStateOf(sessionId) }
    val vm: CaptureViewModel = viewModel(
        key = "capture:$projectId:${sessionId ?: "new"}",
        factory = viewModelFactory { initializer { CaptureViewModel(app, projectId, savedSessionId) } },
    )
    val ui by vm.ui.collectAsStateWithLifecycle()
    LaunchedEffect(ui.sessionId) { ui.sessionId?.let { savedSessionId = it } }

    var showReview by rememberSaveable { mutableStateOf(false) }
    val reviewSession = ui.sessionId
    if (showReview && reviewSession != null) {
        // The review replaces the camera (which is released meanwhile). Photos deleted there
        // disappear from the count and the coverage here.
        BackHandler { showReview = false }
        FrameReviewScreen(
            projectId = projectId, sessionId = reviewSession,
            onContinue = { onFinished(reviewSession) },
            onAddByCamera = { showReview = false },
            onBack = { showReview = false },
        )
        return
    }

    CaptureWindowEffects(vm)

    // The camera UI is dark regardless of the system theme, like every camera.
    Pocket3DTheme(darkTheme = true) {
    Surface(Modifier.fillMaxSize(), color = Color.Black, contentColor = MaterialTheme.colorScheme.onSurface) {
        when {
            ui.fatal != null -> CaptureProblem(
                title = "Capture cannot start", body = ui.fatal!!, onBack = onBack, onImportInstead = onImportInstead)
            ui.loading || ui.plan == EnginePlan.CHECKING -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    CircularProgressIndicator()
                    Spacer(Modifier.height(16.dp))
                    Text("Checking what this phone can do…", style = MaterialTheme.typography.bodyMedium)
                }
            }
            ui.plan == EnginePlan.AR_INSTALL_PROMPT -> ArInstallPrompt(vm, onBack)
            else -> CaptureStage(
                vm = vm, ui = ui,
                onDone = { ui.sessionId?.let(onFinished) },
                onReview = { showReview = true },
                onBack = onBack, onImportInstead = onImportInstead,
            )
        }
    }
    }
}

/** Portrait lock, screen kept on, physical orientation tracking and storage re-check on resume. */
@Composable
private fun CaptureWindowEffects(vm: CaptureViewModel) {
    val context = LocalContext.current
    val view = LocalView.current
    DisposableEffect(Unit) {
        val activity = context.findActivity()
        val previous = activity?.requestedOrientation
        // The UI stays portrait; how the phone is actually held goes into each photo's EXIF tag.
        activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        view.keepScreenOn = true
        val listener = object : OrientationEventListener(context) {
            override fun onOrientationChanged(orientation: Int) {
                vm.deviceRotationCw = DeviceOrientation.snap(orientation, vm.deviceRotationCw)
            }
        }
        if (listener.canDetectOrientation()) listener.enable()
        onDispose {
            listener.disable()
            view.keepScreenOn = false
            activity?.requestedOrientation = previous ?: ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
    }
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) vm.onResume() }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
}

@Composable
private fun CaptureProblem(title: String, body: String, onBack: () -> Unit, onImportInstead: () -> Unit,
                           onRetry: (() -> Unit)? = null, retryLabel: String = "Try again") {
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(24.dp),
           verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        InfoBanner(title = title, body = body, tone = Tone.Bad)
        Spacer(Modifier.height(20.dp))
        if (onRetry != null) {
            Button(onClick = onRetry, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text(retryLabel) }
            Spacer(Modifier.height(8.dp))
        }
        OutlinedButton(onClick = onImportInstead, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text("Import photos instead") }
        Spacer(Modifier.height(8.dp))
        TextButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) { Text("Back") }
    }
}

/**
 * ARCore is supported but Google Play Services for AR is missing or outdated. The user decides:
 * install (Play Store flow driven by `ArCoreApk.requestInstall`) or continue without tracking.
 */
@Composable
private fun ArInstallPrompt(vm: CaptureViewModel, onBack: () -> Unit) {
    val context = LocalContext.current
    var installRequested by rememberSaveable { mutableStateOf(false) }

    fun request(activity: Activity, userRequested: Boolean) {
        try {
            when (ArCoreApk.getInstance().requestInstall(activity, userRequested)) {
                ArCoreApk.InstallStatus.INSTALL_REQUESTED -> installRequested = true   // continues in onResume
                ArCoreApk.InstallStatus.INSTALLED -> { installRequested = false; vm.onArInstalled() }
                else -> Unit
            }
        } catch (e: UnavailableUserDeclinedInstallationException) {
            installRequested = false
            vm.onArInstallDeclined("Google Play Services for AR was not installed, so positions are not tracked. " +
                "Viewpoint coverage is estimated from the phone's orientation.")
        } catch (e: UnavailableDeviceNotCompatibleException) {
            installRequested = false
            vm.onArInstallDeclined("This phone turned out not to be compatible with ARCore. " +
                "Viewpoint coverage is estimated from the phone's orientation.")
        } catch (t: Throwable) {
            installRequested = false
            vm.onArInstallDeclined("AR support could not be installed (${t.describe()}). " +
                "Viewpoint coverage is estimated from the phone's orientation.")
        }
    }

    // After the Play Store flow the activity resumes: ask again to learn the outcome.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME && installRequested) {
                context.findActivity()?.let { request(it, userRequested = false) }
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(24.dp),
           verticalArrangement = Arrangement.Center) {
        Text("AR tracking is available on this phone", style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(8.dp))
        Text(
            "With Google Play Services for AR the app tracks where the phone is while you walk around the object: " +
                "coverage is measured instead of estimated, and the model can get a real-world scale. It must be " +
                "installed or updated from the Play Store first.",
            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(20.dp))
        Button(
            onClick = {
                val activity = context.findActivity()
                if (activity == null) vm.onArInstallDeclined("AR support cannot be installed from here. Viewpoint coverage is estimated from the phone's orientation.")
                else request(activity, userRequested = true)
            },
            modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
        ) { Text("Install AR support") }
        Spacer(Modifier.height(8.dp))
        OutlinedButton(
            onClick = {
                vm.onArInstallDeclined("You chose to continue without AR tracking. Photos are taken at full resolution; " +
                    "viewpoint coverage is estimated from the phone's orientation.")
            },
            modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
        ) { Text("Continue without AR tracking") }
        Spacer(Modifier.height(8.dp))
        TextButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) { Text("Back") }
    }
}

// =====================================================================================================
// Engine hosts
// =====================================================================================================

@Composable
private fun CameraEngineHost(vm: CaptureViewModel, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val engine = remember { CameraXEngine(context) }
    val previewView = remember {
        PreviewView(context).apply {
            // TextureView-based: composes correctly under the overlays; FIT shows the whole photo frame.
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            scaleType = PreviewView.ScaleType.FIT_CENTER
        }
    }
    DisposableEffect(engine, lifecycleOwner) {
        engine.start(lifecycleOwner, previewView)
        vm.attach(engine)
        onDispose {
            vm.detach(engine)
            engine.stop()
        }
    }
    AndroidView(factory = { previewView }, modifier = modifier)
}

@Composable
private fun ArEngineHost(vm: CaptureViewModel, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val engine = remember { ArEngine(context) }
    val glView = remember { GLSurfaceView(context).also { engine.bind(it) } }
    DisposableEffect(engine, lifecycleOwner) {
        // Adding the observer replays the lifecycle up to its current state, so ON_RESUME arrives here too.
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> engine.resume()   // a failure is published as EngineStatus.Failed
                Lifecycle.Event.ON_PAUSE -> engine.pause()
                else -> Unit
            }
        }
        vm.attach(engine)
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            vm.detach(engine)
            engine.destroy()
        }
    }
    // Any ARCore failure, at start or later, ends here: explain it and continue with plain photos.
    val status by engine.status.collectAsState()
    LaunchedEffect(status) {
        (status as? EngineStatus.Failed)?.let { vm.onArFailed(it.message) }
    }
    AndroidView(factory = { glView }, modifier = modifier)
}

// =====================================================================================================
// The shared capture UI
// =====================================================================================================

@Composable
private fun CaptureStage(
    vm: CaptureViewModel,
    ui: CaptureUiState,
    onDone: () -> Unit,
    onReview: () -> Unit,
    onBack: () -> Unit,
    onImportInstead: () -> Unit,
) {
    val live by vm.live.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    var showHelp by rememberSaveable { mutableStateOf(false) }
    val view = LocalView.current

    val message = ui.message
    LaunchedEffect(message?.id) {
        if (message != null) {
            vm.messageShown(message.id)
            snackbar.showSnackbar(message.text)
        }
    }

    // Flash + haptic tick for every photo that was actually stored (not on rotation / return).
    val flash = remember { Animatable(0f) }
    var seenTick by rememberSaveable { mutableIntStateOf(ui.storedTick) }
    LaunchedEffect(ui.storedTick) {
        val previous = seenTick
        seenTick = ui.storedTick
        if (ui.storedTick > previous) {
            view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
            flash.snapTo(0.55f)
            flash.animateTo(0f, tween(180))
        }
    }

    // "Try again" after a camera failure restarts the engine by recomposing its host under a new key.
    var cameraAttempt by remember { mutableIntStateOf(0) }
    val cameraFailure = (ui.engineStatus as? EngineStatus.Failed)?.takeIf { ui.engineKind == EngineKind.CAMERA }

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val isAr = ui.plan == EnginePlan.AR
        // Short screens get a compact coverage card so the preview keeps most of the height.
        val compact = maxHeight < 720.dp

        Column(Modifier.fillMaxSize()) {
            // --- top bar --------------------------------------------------------------------------
            Row(Modifier.statusBarsPadding().fillMaxWidth().height(56.dp).padding(horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back") }
                Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    when {
                        // the mode is "AR"; whether it is tracking RIGHT NOW is the second pill
                        isAr -> StatusPill("AR MODE", if (live.trackingOk) Tone.Good else Tone.Warn)
                        ui.engineInfo.viewpointSource == ViewpointSource.IMU -> StatusPill("ORIENTATION ESTIMATE", Tone.Provisional)
                        ui.engineKind != null -> StatusPill("NO VIEWPOINT SENSOR", Tone.Warn)
                    }
                    val trackingLabel = live.trackingLabel
                    if (isAr && trackingLabel != null) {
                        StatusPill(trackingLabel.uppercase(), if (live.trackingOk) Tone.Good else Tone.Warn,
                                   modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                    }
                    if (ui.engineInfo.lock.requested && !ui.engineInfo.lock.inProgress) StatusPill("LOCKED", Tone.Good, icon = Icons.Outlined.Lock)
                }
                Text("${ui.photoCount}", style = NumericStyle, modifier = Modifier.padding(horizontal = 8.dp).semantics {
                    contentDescription = "${ui.photoCount} photo${if (ui.photoCount == 1) "" else "s"} stored"
                })
                IconButton(onClick = { showHelp = true }) { Icon(Icons.AutoMirrored.Outlined.HelpOutline, contentDescription = "How capture works") }
                CaptureMenu(ui, vm, onImportInstead)
            }

            // --- preview with framing guide, warnings and banners ------------------------------------
            Box(Modifier.weight(1f).fillMaxWidth()) {
                if (isAr) {
                    // ARCore fills the view and crops the camera image to it: the stored photo shows
                    // at least what is visible here.
                    ArEngineHost(vm, Modifier.fillMaxSize())
                    FramingGuide(Modifier.fillMaxSize(), emphasiseReticle = true)
                } else {
                    // The whole 4:3 photo frame is visible (letterboxed), so the guide matches the photo.
                    Box(Modifier.align(Alignment.Center).aspectRatio(3f / 4f)) {
                        androidx.compose.runtime.key(cameraAttempt) { CameraEngineHost(vm, Modifier.fillMaxSize()) }
                        FramingGuide(Modifier.fillMaxSize())
                    }
                }
                if (flash.value > 0f) Box(Modifier.fillMaxSize().background(Color.White.copy(alpha = flash.value)))
                if (ui.engineStatus is EngineStatus.Starting) CircularProgressIndicator(Modifier.align(Alignment.Center))

                Column(Modifier.align(Alignment.TopCenter).padding(top = 6.dp, start = 12.dp, end = 12.dp).fillMaxWidth(),
                       horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    val interrupted = ui.engineStatus as? EngineStatus.Interrupted
                    if (interrupted != null) OverlayBanner(CaptureBanner("interrupted", "Camera interrupted", interrupted.message, Tone.Warn), onDismiss = null)
                    val advice = live.trackingAdvice
                    if (isAr && !live.trackingOk && advice != null && ui.engineStatus is EngineStatus.Running) {
                        OverlayBanner(CaptureBanner("tracking", live.trackingLabel ?: "Tracking paused",
                            "$advice Auto capture is paused; photos taken now are stored without a position.", Tone.Warn),
                            onDismiss = null)
                    }
                    // Most severe first; at most two so the object stays visible.
                    val ordered = ui.banners.sortedBy { when (it.tone) { Tone.Bad -> 0; Tone.Warn -> 1; else -> 2 } }.take(2)
                    for (b in ordered) {
                        val dismissible = !(b.id == "storage" && ui.storage == StorageLevel.BLOCKED)
                        OverlayBanner(b, onDismiss = if (dismissible) ({ vm.dismissBanner(b.id) }) else null)
                    }
                    for (w in live.warnings) WarningChip(w.text, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                }
                SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter))
            }

            // --- bottom panel ----------------------------------------------------------------------
            Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface)
                       .navigationBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp)) {
                val autoHint = live.autoHint
                val hint = when {
                    ui.storage == StorageLevel.BLOCKED -> "Storage is almost full — capture is paused."
                    autoHint != null -> autoHint
                    else -> ui.guidance
                }
                Text(hint, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis,
                     modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite })
                Spacer(Modifier.height(2.dp))

                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    FilterChip(
                        selected = ui.autoCapture, onClick = vm::toggleAuto, enabled = ui.autoAvailable,
                        label = { Text(if (ui.autoAvailable) "Auto capture" else "Auto capture unavailable") },
                        leadingIcon = if (ui.autoCapture) { { Icon(Icons.Outlined.Check, null, Modifier.size(FilterChipDefaults.IconSize)) } } else null,
                        modifier = Modifier.semantics { stateDescription = if (ui.autoCapture) "On" else "Off" },
                    )
                    if (isAr) {
                        FilterChip(
                            selected = ui.objectSet, onClick = vm::setObject,
                            enabled = !ui.settingObject && ui.engineStatus is EngineStatus.Running,
                            label = { Text(if (ui.objectSet) "Object set — aim & tap to move" else "Set object") },
                            leadingIcon = { Icon(Icons.Outlined.MyLocation, null, Modifier.size(FilterChipDefaults.IconSize)) },
                            modifier = Modifier.semantics {
                                stateDescription = if (ui.objectSet) "Object centre is set"
                                else "Object centre not set; coverage is estimated from phone orientation"
                            },
                        )
                    } else if (ui.engineKind == EngineKind.CAMERA) {
                        val lock = ui.engineInfo.lock
                        FilterChip(
                            selected = lock.requested, onClick = { vm.setLock(!lock.requested) }, enabled = lock.anySupported,
                            label = { Text(if (lock.anySupported) "Lock focus & exposure" else "Lock not supported") },
                            leadingIcon = {
                                Icon(if (lock.requested) Icons.Outlined.Lock else Icons.Outlined.LockOpen, null, Modifier.size(FilterChipDefaults.IconSize))
                            },
                            modifier = Modifier.semantics { stateDescription = if (lock.requested) "Locked" else "Not locked" },
                        )
                    }
                }
                // What the lock really did — or that this camera cannot lock at all.
                if (!isAr && ui.engineKind == EngineKind.CAMERA) {
                    val lock = ui.engineInfo.lock
                    val lockText = when {
                        lock.requested -> listOfNotNull(lock.detail, lock.unsupportedText.takeIf { !lock.inProgress && lock.detail == null }).joinToString(" ")
                        !lock.anySupported -> lock.unsupportedText
                        else -> null
                    }
                    if (!lockText.isNullOrBlank()) Text(lockText, style = MaterialTheme.typography.bodySmall,
                                                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (isAr && !ui.objectSet && ui.engineStatus is EngineStatus.Running) {
                    Text("Aim the reticle at the object and tap “Set object” for tracked coverage. Until then it is estimated from phone orientation.",
                         style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Spacer(Modifier.height(6.dp))

                CoverageCard(ui.coverage, ui.coverageKind, live.viewpoint, ui.photosWithoutViewpoint, ui.segmentCount,
                             modifier = Modifier.fillMaxWidth(), compact = compact)
                Spacer(Modifier.height(6.dp))

                // Controls: review + undo on the left, shutter in the middle, done on the right.
                Box(Modifier.fillMaxWidth().height(84.dp)) {
                    Row(Modifier.align(Alignment.CenterStart), verticalAlignment = Alignment.CenterVertically) {
                        ReviewButton(ui, onReview)
                        Spacer(Modifier.width(4.dp))
                        IconButton(onClick = vm::undoLast, enabled = ui.canUndo && !ui.busy, modifier = Modifier.size(48.dp)) {
                            Icon(Icons.AutoMirrored.Outlined.Undo, contentDescription = "Undo last photo")
                        }
                    }
                    ShutterButton(
                        enabled = ui.engineStatus is EngineStatus.Running && ui.storage != StorageLevel.BLOCKED && ui.pendingReasons == null,
                        busy = ui.busy, onClick = vm::onShutter, modifier = Modifier.align(Alignment.Center),
                    )
                    FilledTonalButton(onClick = onDone, enabled = ui.photoCount > 0 && ui.pendingReasons == null && !ui.busy,
                                      modifier = Modifier.align(Alignment.CenterEnd).heightIn(min = 48.dp)) {
                        Text("Done")
                    }
                }
            }
        }

        // --- the plain camera is the last resort: if it cannot run, say so and offer the import ------
        if (cameraFailure != null) {
            Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
                CaptureProblem(title = "The camera is not available", body = cameraFailure.message, onBack = onBack,
                               onImportInstead = onImportInstead, onRetry = { cameraAttempt++ })
            }
        }

        // --- weak manual photo: keep or discard -------------------------------------------------
        ui.pendingReasons?.let { reasons ->
            // The scrim swallows touches so nothing underneath reacts while the question is open.
            Box(Modifier.fillMaxSize().background(P3.colors.scrim).pointerInput(Unit) { detectTapGestures { } },
                contentAlignment = Alignment.Center) {
                Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainerHigh,
                        modifier = Modifier.padding(24.dp).widthIn(max = 420.dp)) {
                    Column(Modifier.padding(20.dp)) {
                        Text("This photo may not help", style = MaterialTheme.typography.titleMedium)
                        Spacer(Modifier.height(8.dp))
                        for (r in reasons) {
                            Row(Modifier.padding(vertical = 3.dp), verticalAlignment = Alignment.Top) {
                                Text("•", color = P3.colors.warn, modifier = Modifier.width(16.dp))
                                Text(r, style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                        Spacer(Modifier.height(4.dp))
                        Text("It has not been saved yet. Kept photos stay flagged so you can exclude them in the review.",
                             style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.height(16.dp))
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            OutlinedButton(onClick = vm::keepPending, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("Keep anyway") }
                            Button(onClick = vm::discardPending, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("Discard") }
                        }
                    }
                }
            }
        }
    }

    if (showHelp) CaptureHelpSheet(ui.engineKind, ui.engineInfo, onDismiss = { showHelp = false })
}

@Composable
private fun CaptureMenu(ui: CaptureUiState, vm: CaptureViewModel, onImportInstead: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }) { Icon(Icons.Outlined.MoreVert, contentDescription = "More options") }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            if (ui.arUsable) {
                if (ui.plan == EnginePlan.AR) {
                    DropdownMenuItem(text = { Text("High-resolution photos (no position tracking)") },
                                     onClick = { open = false; vm.switchEngine(toAr = false) })
                } else {
                    DropdownMenuItem(text = { Text("AR tracked capture") }, onClick = { open = false; vm.switchEngine(toAr = true) })
                }
            }
            if (ui.arCheckInconclusive) {
                DropdownMenuItem(text = { Text("Check AR support again") }, onClick = { open = false; vm.retryArCheck() })
            }
            DropdownMenuItem(text = { Text("Import photos instead") }, onClick = { open = false; onImportInstead() })
        }
    }
}

@Composable
private fun OverlayBanner(banner: CaptureBanner, onDismiss: (() -> Unit)?) {
    Surface(color = MaterialTheme.colorScheme.surfaceContainer.copy(alpha = 0.94f), shape = MaterialTheme.shapes.medium,
            modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }) {
        Box {
            InfoBanner(title = banner.title, body = banner.body, tone = banner.tone,
                       modifier = Modifier.padding(end = if (onDismiss != null) 40.dp else 0.dp))
            if (onDismiss != null) {
                IconButton(onClick = onDismiss, modifier = Modifier.align(Alignment.TopEnd).size(48.dp),
                           colors = IconButtonDefaults.iconButtonColors(contentColor = MaterialTheme.colorScheme.onSurfaceVariant)) {
                    Icon(Icons.Outlined.Close, contentDescription = "Dismiss: ${banner.title}", modifier = Modifier.size(18.dp))
                }
            }
        }
    }
}

/** Thumbnail of the last stored photo with the count; opens the review. */
@Composable
private fun ReviewButton(ui: CaptureUiState, onReview: () -> Unit) {
    val enabled = ui.photoCount > 0 && ui.sessionId != null
    val shape = RoundedCornerShape(12.dp)
    Box(
        Modifier.size(56.dp).clip(shape).background(MaterialTheme.colorScheme.surfaceContainerHighest)
            .clickable(enabled = enabled, role = Role.Button, onClickLabel = "Review photos", onClick = onReview)
            .semantics { contentDescription = "Review ${ui.photoCount} photo${if (ui.photoCount == 1) "" else "s"}" },
        contentAlignment = Alignment.Center,
    ) {
        val file = ui.lastFrameFile
        val frame = ui.lastFrame
        if (file != null && frame != null) {
            FrameThumbnail(file = file, exifOrientation = frame.exifOrientation, modifier = Modifier.fillMaxSize(), targetPx = 160)
            Text("${ui.photoCount}", style = MaterialTheme.typography.labelSmall, textAlign = TextAlign.Center,
                 modifier = Modifier.align(Alignment.BottomEnd).padding(3.dp).clip(RoundedCornerShape(6.dp))
                     .background(P3.colors.scrim).padding(horizontal = 5.dp, vertical = 1.dp))
        } else {
            Icon(Icons.Outlined.PhotoLibrary, contentDescription = null,
                 tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = if (enabled) 1f else 0.5f))
        }
    }
}
