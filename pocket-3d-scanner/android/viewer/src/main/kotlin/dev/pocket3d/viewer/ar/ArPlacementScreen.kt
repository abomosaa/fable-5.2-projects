package dev.pocket3d.viewer

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.display.DisplayManager
import android.net.Uri
import android.opengl.GLSurfaceView
import android.provider.Settings
import android.view.Surface
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateRotation
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.google.ar.core.ArCoreApk
import com.google.ar.core.Session
import com.google.ar.core.exceptions.UnavailableDeviceNotCompatibleException
import com.google.ar.core.exceptions.UnavailableUserDeclinedInstallationException
import dev.pocket3d.design.InfoBanner
import dev.pocket3d.design.StatusPill
import dev.pocket3d.design.Tone
import dev.pocket3d.viewer.ar.arFailureText
import dev.pocket3d.viewer.ar.ArInput
import dev.pocket3d.viewer.ar.ArModelState
import dev.pocket3d.viewer.ar.ArRenderer
import dev.pocket3d.viewer.ar.ArSizing
import dev.pocket3d.viewer.ar.ArStatus
import dev.pocket3d.viewer.ar.ArUiState
import dev.pocket3d.viewer.ar.ArViewModel
import dev.pocket3d.viewer.scene.MeshBuffers
import dev.pocket3d.viewer.ui.Hint
import dev.pocket3d.viewer.ui.ToggleRow
import kotlinx.coroutines.delay

/** Where the checks before AR can start currently stand. */
private sealed interface ArGate {
    data class Checking(val message: String) : ArGate
    /** AR cannot be used; [canRetry] offers to run the checks again, [settings] to open the app's system settings. */
    data class Unavailable(val title: String, val detail: String, val canRetry: Boolean = false, val settings: Boolean = false) : ArGate
    data object Ready : ArGate
}

private fun Context.findActivity(): Activity? {
    var c: Context? = this
    while (c is ContextWrapper) { if (c is Activity) return c; c = c.baseContext }
    return null
}

/**
 * Places the model in the room with ARCore. There is no camera-less imitation: when AR is not
 * possible (unsupported device, AR services not installed or declined, camera permission denied,
 * session failure) the screen says why and offers the normal 3D viewer instead.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ArPlacementScreen(projectId: String, modelId: String, onBack: () -> Unit, onOpenViewer: () -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val vm: ArViewModel = viewModel(key = "ar/$projectId/$modelId",
                                    factory = viewModelFactory { initializer { ArViewModel(projectId, modelId) } })
    val state by vm.state.collectAsStateWithLifecycle()

    var gate by remember { mutableStateOf<ArGate>(if (vm.session != null) ArGate.Ready else ArGate.Checking("Checking AR support…")) }
    var installRequested by rememberSaveable { mutableStateOf(false) }
    var permissionAsked by rememberSaveable { mutableStateOf(false) }
    var check by remember { mutableIntStateOf(0) }
    var permissionPending by remember { mutableStateOf(false) }

    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        permissionPending = false
        if (granted) check++
        else gate = ArGate.Unavailable("Camera permission denied",
            "AR placement shows the model in the live camera image, so it cannot work without the camera. " +
                "You can allow the camera for this app in the system settings, or look at the model in the 3D viewer.",
            canRetry = true, settings = true)
    }

    // Coming back from the Play Store (AR services install) or from system settings: check again.
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) check++ }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }

    LaunchedEffect(check) {
        if (vm.session != null) { gate = ArGate.Ready; return@LaunchedEffect }
        val activity = context.findActivity()
        if (activity == null) {
            gate = ArGate.Unavailable("AR could not be started", "The screen is not attached to an activity.")
            return@LaunchedEffect
        }
        try {
            // 1. Is ARCore supported / installed? The first answer may still be "checking".
            val api = ArCoreApk.getInstance()
            var availability = api.checkAvailability(context)
            var waited = 0
            while (availability.isTransient && waited < 25) { delay(200); waited++; availability = api.checkAvailability(context) }
            if (availability.isTransient || availability == ArCoreApk.Availability.UNKNOWN_ERROR ||
                availability == ArCoreApk.Availability.UNKNOWN_TIMED_OUT) {
                gate = ArGate.Unavailable("AR support could not be determined",
                    "The check for Google Play Services for AR did not finish (this needs a network connection the first time).", canRetry = true)
                return@LaunchedEffect
            }
            if (!availability.isSupported) {
                gate = ArGate.Unavailable("AR is not supported on this device",
                    "This phone is not certified for ARCore, so the model cannot be placed in the room. You can still inspect it in the 3D viewer.")
                return@LaunchedEffect
            }
            if (availability != ArCoreApk.Availability.SUPPORTED_INSTALLED) {
                gate = ArGate.Checking("Google Play Services for AR needs to be installed or updated…")
                if (api.requestInstall(activity, !installRequested) == ArCoreApk.InstallStatus.INSTALL_REQUESTED) {
                    installRequested = true
                    return@LaunchedEffect // the install flow pauses this screen; the check continues on resume
                }
            }
            // 2. Camera permission.
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                if (permissionPending) return@LaunchedEffect   // the system dialog is open; its result decides
                if (!permissionAsked) {
                    permissionAsked = true
                    permissionPending = true
                    gate = ArGate.Checking("AR needs the camera to show the model in your room.")
                    permissionLauncher.launch(Manifest.permission.CAMERA)
                } else if (gate !is ArGate.Unavailable) {
                    gate = ArGate.Unavailable("Camera permission needed",
                        "AR placement shows the model in the live camera image. Allow the camera to continue, or open the 3D viewer instead.",
                        canRetry = true, settings = true)
                }
                return@LaunchedEffect
            }
            // 3. Session.
            gate = ArGate.Checking("Starting AR…")
            val problem = vm.ensureSession(activity)
            gate = if (problem == null) ArGate.Ready else ArGate.Unavailable(problem.title, problem.detail, canRetry = true)
        } catch (e: UnavailableUserDeclinedInstallationException) {
            gate = ArGate.Unavailable("Google Play Services for AR was not installed",
                "AR placement needs it, and the installation was declined. You can still inspect the model in the 3D viewer.", canRetry = true)
        } catch (e: UnavailableDeviceNotCompatibleException) {
            gate = ArGate.Unavailable("AR is not supported on this device",
                "This phone is not certified for ARCore, so the model cannot be placed in the room.")
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            dev.pocket3d.core.services.ArRuntimeStatus.reportFailed(e.javaClass.simpleName)
            gate = ArGate.Unavailable("AR could not be started", arFailureText(e), canRetry = true)
        }
    }

    val g = gate
    val session = vm.session
    val buffers = vm.buffers
    val model = state.model
    when {
        g is ArGate.Unavailable -> ArExplanation(g.title, g.detail, onBack, onOpenViewer,
            onRetry = if (g.canRetry) { { installRequested = false; permissionAsked = false; gate = ArGate.Checking("Checking AR support…"); check++ } } else null,
            onSettings = if (g.settings) { {
                try {
                    context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (e: Exception) { /* no settings screen on this device */ }
            } } else null)
        model is ArModelState.Failed -> ArExplanation(model.title, model.detail, onBack, onOpenViewer, onRetry = { vm.load() }, onSettings = null)
        state.status.error != null -> ArExplanation("AR stopped", state.status.error ?: "", onBack, onOpenViewer, onRetry = null, onSettings = null)
        g is ArGate.Ready && model is ArModelState.Ready && session != null && buffers != null -> ArContent(vm, state, session, buffers, onBack, onOpenViewer)
        else -> Scaffold(topBar = {
            TopAppBar(title = { Text("Place in AR") },
                      navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") } })
        }) { padding ->
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(24.dp)) {
                    CircularProgressIndicator()
                    Spacer(Modifier.height(16.dp))
                    Text(when {
                        g is ArGate.Checking -> g.message
                        model is ArModelState.Loading -> model.message
                        else -> "Starting AR…"
                    }, style = MaterialTheme.typography.bodyMedium)
                    Spacer(Modifier.height(24.dp))
                    OutlinedButton(onClick = onOpenViewer) { Text("Open 3D viewer instead") }
                }
            }
        }
    }
}

/** Honest explanation of why AR is not available, with the way to the normal viewer. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ArExplanation(title: String, detail: String, onBack: () -> Unit, onOpenViewer: () -> Unit, onRetry: (() -> Unit)?, onSettings: (() -> Unit)?) {
    Scaffold(topBar = {
        TopAppBar(title = { Text("Place in AR") },
                  navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") } })
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(24.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.Center) {
            InfoBanner(title, body = detail, tone = Tone.Warn)
            Spacer(Modifier.height(8.dp))
            Hint("Nothing is simulated here: without working AR there is no room view. The 3D viewer shows the same model with all tools.")
            Spacer(Modifier.height(16.dp))
            Button(onClick = onOpenViewer, modifier = Modifier.fillMaxWidth()) { Text("Open 3D viewer") }
            if (onRetry != null) OutlinedButton(onClick = onRetry, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) { Text("Try again") }
            if (onSettings != null) OutlinedButton(onClick = onSettings, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) { Text("Open app settings") }
        }
    }
}

private class ArViewHolder(val view: GLSurfaceView, val renderer: ArRenderer)

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ArContent(vm: ArViewModel, state: ArUiState, session: Session, buffers: MeshBuffers, onBack: () -> Unit, onOpenViewer: () -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var resumeError by remember { mutableStateOf<String?>(null) }
    var resumeAttempt by remember { mutableIntStateOf(0) }

    val holder = remember(session, buffers) {
        val view = GLSurfaceView(context)
        val renderer = ArRenderer(session, vm.placement, buffers,
                                  displayRotation = { view.display?.rotation ?: Surface.ROTATION_0 },
                                  onStatus = { s -> view.post { vm.onStatus(s) } })
        view.preserveEGLContextOnPause = true
        view.setEGLContextClientVersion(3)
        view.setEGLConfigChooser(8, 8, 8, 8, 16, 0)
        view.setRenderer(renderer)
        view.renderMode = GLSurfaceView.RENDERMODE_CONTINUOUSLY
        view.setWillNotDraw(false)
        ArViewHolder(view, renderer)
    }

    // Session and GL view follow the lifecycle: camera released while in the background.
    DisposableEffect(holder, lifecycle, resumeAttempt) {
        fun resume() {
            resumeError = vm.resumeSession()
            if (resumeError == null) holder.view.onResume()
        }
        fun pause() {
            holder.view.onPause()
            vm.pauseSession()
        }
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> resume()
                Lifecycle.Event.ON_PAUSE -> pause()
                else -> {}
            }
        }
        lifecycle.addObserver(observer)
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) resume()
        onDispose {
            lifecycle.removeObserver(observer)
            pause()
        }
    }

    // 180° rotations do not change the surface size, so listen for display changes as well.
    DisposableEffect(holder) {
        val dm = context.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
        val listener = object : DisplayManager.DisplayListener {
            override fun onDisplayAdded(displayId: Int) {}
            override fun onDisplayRemoved(displayId: Int) {}
            override fun onDisplayChanged(displayId: Int) { holder.renderer.geometryChanged = true }
        }
        dm?.registerDisplayListener(listener, null)
        onDispose { dm?.unregisterDisplayListener(listener) }
    }

    val sizing = state.sizing
    val status = state.status
    Box(Modifier.fillMaxSize()) {
        AndroidView(factory = { holder.view }, modifier = Modifier.fillMaxSize())
        Box(Modifier.fillMaxSize()
            .semantics { contentDescription = "Camera view. Tap a detected surface to place the model, drag to move it, twist with two fingers to turn it." }
            .pointerInput(vm) {
                val slop = viewConfiguration.touchSlop
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    val start = down.position
                    var mode = 0 // 0 undecided, 1 drag, 2 two fingers
                    while (true) {
                        val event = awaitPointerEvent()
                        val pressed = event.changes.filter { it.pressed }
                        if (pressed.isEmpty()) break
                        if (pressed.size >= 2) {
                            if (mode == 1) vm.send(ArInput.DragEnd)
                            mode = 2
                            val rot = event.calculateRotation()
                            if (rot != 0f) vm.twist(-Math.toRadians(rot.toDouble()).toFloat())
                            val zoom = event.calculateZoom()
                            if (zoom != 1f) vm.pinch(zoom)
                            event.changes.forEach { it.consume() }
                        } else if (mode != 2) {
                            val c = pressed[0]
                            if (mode == 0 && (c.position - start).getDistance() > slop) mode = 1
                            if (mode == 1) { vm.send(ArInput.DragTo(c.position.x, c.position.y)); c.consume() }
                        }
                    }
                    when (mode) {
                        0 -> vm.send(ArInput.Tap(start.x, start.y))
                        1 -> vm.send(ArInput.DragEnd)
                    }
                }
            })

        // top: back, title, size label, coaching
        Column(Modifier.align(Alignment.TopCenter).windowInsetsPadding(WindowInsets.safeDrawing).padding(8.dp).widthIn(max = 560.dp)) {
            Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surface.copy(alpha = 0.88f)) {
                Row(Modifier.fillMaxWidth().padding(end = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") }
                    Column(Modifier.weight(1f).padding(vertical = 6.dp)) {
                        Text(state.title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (sizing != null) {
                            val label = sizing.label()
                            StatusPill(label.text, label.tone, modifier = Modifier.semantics { contentDescription = "Size: ${label.text}" })
                        }
                    }
                }
            }
            Spacer(Modifier.height(8.dp))
            val coaching = arCoaching(status, sizing, resumeError)
            if (coaching != null) {
                Surface(shape = RoundedCornerShape(14.dp), color = MaterialTheme.colorScheme.surface.copy(alpha = 0.9f)) {
                    InfoBanner(coaching.first, body = coaching.second, tone = coaching.third,
                               actionLabel = if (resumeError != null) "Try again" else null,
                               onAction = if (resumeError != null) { { resumeAttempt++ } } else null)
                }
            }
        }

        // bottom: size controls
        Surface(Modifier.align(Alignment.BottomCenter).windowInsetsPadding(WindowInsets.safeDrawing).padding(8.dp).widthIn(max = 560.dp),
                shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f)) {
            Column(Modifier.fillMaxWidth().heightIn(max = 300.dp).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 10.dp)) {
                if (sizing != null) {
                    val label = sizing.label()
                    Text(label.text, style = MaterialTheme.typography.titleSmall)
                    Hint(label.detail)
                    if (sizing.hasScale) {
                        ToggleRow("Unlock scale", sizing.scaleUnlocked, { vm.setUnlocked(it) },
                                  supporting = if (sizing.scaleUnlocked) "Pinch to resize. The result is no longer true size." else "Pinch-resizing is off so the model stays at true size.")
                    } else {
                        val m = sizing.manualLongestMeters
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("Longest side", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.width(96.dp))
                            Slider(if (m == null) 0f else ArSizing.sliderFromManual(m), { vm.setManualLongest(ArSizing.manualFromSlider(it)) },
                                   modifier = Modifier.weight(1f).semantics { contentDescription = "Length of the model's longest side" })
                        }
                        if (m != null) Hint("You can also pinch to resize.")
                    }
                }
                ToggleRow("Match room brightness", state.matchBrightness, { vm.setMatchBrightness(it) },
                          supporting = "A gentle overall brightness adjustment only; the scan's own colours and shading are not relit.")
                if (status.texturesReduced) Hint("Texture shown at reduced resolution in AR; export keeps the original.")
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 4.dp)) {
                    OutlinedButton(onClick = { vm.send(ArInput.Remove) }, enabled = status.placed) { Text("Remove") }
                    OutlinedButton(onClick = { vm.twist((Math.PI / 4).toFloat()) }, enabled = status.placed) { Text("Turn 45°") }
                    FilledTonalButton(onClick = onOpenViewer) { Text("Open 3D viewer") }
                }
            }
        }
    }
}

/** (title, body, tone) of the coaching banner, or null when nothing needs saying. */
private fun arCoaching(status: ArStatus, sizing: ArSizing?, resumeError: String?): Triple<String, String?, Tone>? = when {
    resumeError != null -> Triple("Camera not available", resumeError, Tone.Bad)
    !status.cameraTracking && status.placed ->
        Triple("Tracking lost — model hidden", (status.trackingProblem ?: "Move the phone slowly.") +
            " The model is hidden until tracking recovers, so it is never shown in the wrong place.", Tone.Warn)
    !status.cameraTracking -> Triple("Starting AR", status.trackingProblem ?: "Move the phone slowly.", Tone.Neutral)
    status.modelHidden -> Triple("Model hidden", "The spot it was placed on is not being tracked right now. Point the camera back at it.", Tone.Warn)
    !status.planeFound -> Triple("Move the phone to find a surface", "Slowly sweep the camera over a table or the floor. Detected surfaces show a grid.", Tone.Neutral)
    sizing != null && !sizing.canPlace -> Triple("Set the size first", "This model has no real-world scale. Choose the length of its longest side below, then tap a surface.", Tone.Warn)
    status.missedSurface -> Triple("No surface there", "Tap or drag on an area covered by the grid.", Tone.Warn)
    !status.placed -> Triple("Tap a surface to place the model", "It stands on the surface with its lowest point. Drag to move, twist with two fingers to turn.", Tone.Neutral)
    else -> null
}
