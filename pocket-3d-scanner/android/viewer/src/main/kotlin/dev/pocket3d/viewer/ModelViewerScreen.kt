package dev.pocket3d.viewer

import android.app.ActivityManager
import android.content.ActivityNotFoundException
import android.content.Context
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Redo
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.outlined.CameraAlt
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.IosShare
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Straighten
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material.icons.outlined.ViewInAr
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.pocket3d.design.InfoBanner
import dev.pocket3d.design.StatusPill
import dev.pocket3d.design.Tone
import dev.pocket3d.viewer.camera.OrbitCamera
import dev.pocket3d.viewer.export.ExportFormat
import dev.pocket3d.viewer.export.ExportIo
import dev.pocket3d.viewer.ui.CalibrationDialog
import dev.pocket3d.viewer.ui.CameraSheet
import dev.pocket3d.viewer.ui.CamerasPanel
import dev.pocket3d.viewer.ui.ConfirmDialog
import dev.pocket3d.viewer.ui.EditPanel
import dev.pocket3d.viewer.ui.ExportPanel
import dev.pocket3d.viewer.ui.MeasurePanel
import dev.pocket3d.viewer.ui.PhotoState
import dev.pocket3d.viewer.ui.RenameMeasurementDialog
import dev.pocket3d.viewer.ui.StatsSheet
import dev.pocket3d.viewer.ui.ViewPanel
import dev.pocket3d.viewer.ui.Viewport3D
import dev.pocket3d.viewer.ui.ViewerOverlay
import dev.pocket3d.viewer.ui.rememberPhoto

internal fun isLowRamDevice(context: Context): Boolean =
    (context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager)?.let { it.isLowRamDevice || it.memoryClass < 128 } ?: false

private data class NavEntry(val mode: ToolMode?, val label: String, val icon: ImageVector)

private val NavEntries = listOf(
    NavEntry(ToolMode.View, "View", Icons.Outlined.Visibility),
    NavEntry(ToolMode.Edit, "Edit", Icons.Outlined.Tune),
    NavEntry(ToolMode.Measure, "Measure", Icons.Outlined.Straighten),
    NavEntry(ToolMode.Cameras, "Cameras", Icons.Outlined.CameraAlt),
    NavEntry(ToolMode.Export, "Export", Icons.Outlined.IosShare),
    NavEntry(null, "AR", Icons.Outlined.ViewInAr),
)

/**
 * The model viewer: inspect, clean up, measure and export a reconstruction.
 *
 * @param onOpenAr opens AR placement for the same model
 * @param onOpenPhoto optional: opens a source photo in the capture review screen
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ModelViewerScreen(
    projectId: String,
    modelId: String,
    onBack: () -> Unit,
    onOpenAr: () -> Unit,
    onOpenPhoto: ((sessionId: String, frameId: String) -> Unit)? = null,
) {
    val context = LocalContext.current
    val density = LocalDensity.current.density
    val vm: ViewerViewModel = viewModel(
        key = "viewer/$projectId/$modelId",
        factory = viewModelFactory {
            initializer { ViewerViewModel(projectId, modelId, context.applicationContext, density, isLowRamDevice(context)) }
        },
    )
    val state by vm.state.collectAsStateWithLifecycle()
    val camera by vm.controller.camera.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    var showStats by rememberSaveable { mutableStateOf(false) }
    var panelOpen by rememberSaveable { mutableStateOf(true) }
    var menuOpen by remember { mutableStateOf(false) }

    LaunchedEffect(state.notice?.id) {
        val n = state.notice ?: return@LaunchedEffect
        // dismissing first would change this effect's key and cancel the snackbar that is being shown
        snackbar.showSnackbar(n.text)
        vm.dismissNotice()
    }

    LaunchedEffect(state.export.share?.id) {
        val share = state.export.share ?: return@LaunchedEffect
        try {
            context.startActivity(ExportIo.shareIntent(share.uri, share.mimeType, share.title))
        } catch (e: ActivityNotFoundException) {
            snackbar.showSnackbar("No app on this phone can receive the file.")
        }
        vm.shareHandled()
    }

    val saveGlb = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(ExportFormat.GLB.mimeType)) { uri ->
        if (uri != null) vm.exportToDocument(uri)
    }
    val saveZip = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(ExportFormat.OBJ_ZIP.mimeType)) { uri ->
        if (uri != null) vm.exportToDocument(uri)
    }
    val savePly = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(ExportFormat.PLY.mimeType)) { uri ->
        if (uri != null) vm.exportToDocument(uri)
    }
    var pickerMissing by remember { mutableStateOf(false) }
    LaunchedEffect(pickerMissing) {
        if (pickerMissing) { snackbar.showSnackbar("This phone has no file picker to choose a location. Use Share instead."); pickerMissing = false }
    }
    val onSaveTo: (ExportFormat) -> Unit = { f ->
        try {
            when (f) {
                ExportFormat.GLB -> saveGlb.launch(vm.suggestedExportName())
                ExportFormat.OBJ_ZIP -> saveZip.launch(vm.suggestedExportName())
                ExportFormat.PLY -> savePly.launch(vm.suggestedExportName())
            }
        } catch (e: ActivityNotFoundException) {
            pickerMissing = true
        }
    }

    val configuration = LocalConfiguration.current
    val wide = configuration.screenWidthDp > configuration.screenHeightDp
    val onNav: (NavEntry) -> Unit = { e -> if (e.mode == null) onOpenAr() else { vm.setTool(e.mode); panelOpen = true } }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(state.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium)
                        StatusPill(state.scaleStatus.text, state.scaleStatus.tone,
                                   modifier = Modifier.semantics { contentDescription = "Scale: ${state.scaleStatus.text}" })
                    }
                },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") } },
                actions = {
                    if (state.tool == ToolMode.Edit && state.ready) {
                        IconButton(onClick = { vm.undo() }, enabled = state.undoLabel != null && state.busy == null) {
                            Icon(Icons.AutoMirrored.Outlined.Undo, state.undoLabel?.let { "Undo: $it" } ?: "Undo (nothing to undo)")
                        }
                        IconButton(onClick = { vm.redo() }, enabled = state.redoLabel != null && state.busy == null) {
                            Icon(Icons.AutoMirrored.Outlined.Redo, state.redoLabel?.let { "Redo: $it" } ?: "Redo (nothing to redo)")
                        }
                    }
                    if (state.ready) {
                        IconButton(onClick = { menuOpen = true }) { Icon(Icons.Outlined.MoreVert, "More options") }
                        DropdownMenu(menuOpen, onDismissRequest = { menuOpen = false }) {
                            DropdownMenuItem(text = { Text("Model info & statistics") }, onClick = { menuOpen = false; showStats = true })
                            DropdownMenuItem(text = { Text("Fit to view") }, onClick = { menuOpen = false; vm.fitToView() })
                            DropdownMenuItem(text = { Text("Calibrate scale…") }, onClick = { menuOpen = false; vm.startCalibration() })
                            DropdownMenuItem(text = { Text("Reset all edits…") }, enabled = (state.doc?.ops?.isNotEmpty() == true || state.doc?.redo?.isNotEmpty() == true),
                                             onClick = { menuOpen = false; vm.requestReset() })
                        }
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = {
            if (!wide && state.ready) NavigationBar {
                for (e in NavEntries) NavigationBarItem(
                    selected = e.mode == state.tool, onClick = { onNav(e) },
                    icon = { Icon(e.icon, null) }, label = { Text(e.label, maxLines = 1) })
            }
        },
    ) { padding ->
        BoxWithConstraints(Modifier.fillMaxSize().padding(padding)) {
            when (val load = state.load) {
                is LoadState.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator()
                        Spacer(Modifier.height(16.dp))
                        Text(load.message, style = MaterialTheme.typography.bodyMedium)
                    }
                }
                is LoadState.Failed -> Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center) {
                    InfoBanner(load.title, body = load.detail, tone = Tone.Bad)
                    Row(Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { vm.load() }) { Text("Try again") }
                        OutlinedButton(onClick = onBack) { Text("Back") }
                    }
                }
                LoadState.Ready -> {
                    if (wide) {
                        Row(Modifier.fillMaxSize()) {
                            NavigationRail(Modifier.fillMaxHeight().verticalScroll(rememberScrollState())) {
                                for (e in NavEntries) NavigationRailItem(
                                    selected = e.mode == state.tool, onClick = { onNav(e) },
                                    icon = { Icon(e.icon, null) }, label = { Text(e.label) })
                            }
                            ViewportArea(state, vm, camera, Modifier.weight(1f).fillMaxHeight())
                            Surface(tonalElevation = 2.dp, modifier = Modifier.width(340.dp).fillMaxHeight()) {
                                Column(Modifier.verticalScroll(rememberScrollState())) {
                                    ToolPanel(state, vm, camera, onShowStats = { showStats = true }, onSaveTo = onSaveTo)
                                }
                            }
                        }
                    } else {
                        Column(Modifier.fillMaxSize()) {
                            ViewportArea(state, vm, camera, Modifier.weight(1f).fillMaxWidth())
                            Surface(tonalElevation = 2.dp, shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp)) {
                                Column {
                                    Row(Modifier.fillMaxWidth().heightIn(min = 40.dp).padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                        Text(panelTitle(state), style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                                        IconButton(onClick = { panelOpen = !panelOpen }) {
                                            Icon(if (panelOpen) Icons.Outlined.ExpandMore else Icons.Outlined.ExpandLess,
                                                 if (panelOpen) "Collapse tool panel" else "Expand tool panel")
                                        }
                                    }
                                    if (panelOpen) Column(Modifier.heightIn(max = this@BoxWithConstraints.maxHeight * 0.42f).verticalScroll(rememberScrollState())) {
                                        ToolPanel(state, vm, camera, onShowStats = { showStats = true }, onSaveTo = onSaveTo)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // ---- sheets and dialogs ---------------------------------------------------------------------
    if (showStats && state.ready) StatsSheet(state) { showStats = false }

    val selectedCamera = state.cameras.selectedId?.let { id -> state.cameras.placed.firstOrNull { it.source.id == id } }
    if (selectedCamera != null) {
        val photo = state.cameras.photo
        val open: (() -> Unit)? = if (onOpenPhoto != null && photo?.sessionId != null && photo.frameId != null) {
            { onOpenPhoto(photo.sessionId, photo.frameId) }
        } else null
        CameraSheet(state, selectedCamera, onLookFrom = { vm.lookFromCamera(selectedCamera.source.id) }, onOpenPhoto = open,
                    onDismiss = { vm.selectCamera(null) })
    }

    state.measure.calibration?.let { cal -> if (cal.dialogOpen) CalibrationDialog(state, cal, vm) }

    state.measure.renamingId?.let { id ->
        state.measure.rows.firstOrNull { it.measurement.id == id }?.let { row ->
            RenameMeasurementDialog(row, onRename = { vm.renameMeasurement(id, it) }, onDismiss = { vm.setRenaming(null) })
        }
    }

    if (state.confirmReset) ConfirmDialog(
        "Reset all edits?",
        "All ${state.doc?.ops?.size ?: 0} edits are removed and the model returns to the original reconstruction. " +
            "Measurements and the scale calibration are kept. This cannot be undone.",
        "Reset", onConfirm = { vm.confirmReset() }, onDismiss = { vm.cancelReset() })

    if (state.holes.confirming) ConfirmDialog(
        "Repair holes with synthetic surface?",
        "This adds synthetic surface that was not photographed. It is marked as repaired in the viewer and in exports.",
        "Repair", onConfirm = { vm.holesConfirmFill() }, onDismiss = { vm.holesCancelFill() })
}

private fun panelTitle(state: ViewerUiState): String = when (state.tool) {
    ToolMode.View -> "View"
    ToolMode.Edit -> "Edit · ${state.editTool.label}"
    ToolMode.Measure -> if (state.measure.calibration != null) "Calibrate scale" else "Measure"
    ToolMode.Cameras -> "Source cameras"
    ToolMode.Export -> "Export"
}

@Composable
private fun ToolPanel(state: ViewerUiState, vm: ViewerViewModel, camera: OrbitCamera, onShowStats: () -> Unit, onSaveTo: (ExportFormat) -> Unit) {
    when (state.tool) {
        ToolMode.View -> ViewPanel(state, vm, onShowStats)
        ToolMode.Edit -> EditPanel(state, vm)
        ToolMode.Measure -> MeasurePanel(state, vm)
        ToolMode.Cameras -> CamerasPanel(state, vm, camera)
        ToolMode.Export -> ExportPanel(state, vm, onSaveTo)
    }
}

/** The 3D viewport with its overlays: decorations, photo comparison, progress and renderer errors. */
@Composable
private fun ViewportArea(state: ViewerUiState, vm: ViewerViewModel, camera: OrbitCamera, modifier: Modifier) {
    val description = "3D view of ${state.title}, ${state.shading.label.lowercase()} mode. Drag to orbit, pinch to zoom."
    Viewport3D(vm.bridge, vm.controller, vm, description, modifier) {
        // photo of the camera we are looking from, faded over the model
        val cams = state.cameras
        if (cams.lookingFromId != null && cams.overlayAlpha > 0.01f && vm.isLookingFrom(camera)) {
            val pc = cams.placed.firstOrNull { it.source.id == cams.lookingFromId }
            val photo = rememberPhoto(cams.photo?.takeIf { it.cameraId == cams.lookingFromId }?.filePath, cams.photo?.exifOrientation ?: 1)
            if (pc != null && photo is PhotoState.Ready) {
                BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    val viewAspect = maxWidth.value / maxHeight.value.coerceAtLeast(1f)
                    val (wf, hf) = OrbitCamera.photoFrameFraction(pc.fovYRad, pc.aspect, viewAspect)
                    Image(photo.image, "Source photo over the model", contentScale = ContentScale.FillBounds, alpha = cams.overlayAlpha,
                          modifier = Modifier.size(maxWidth * wf, maxHeight * hf).border(1.dp, Color.White.copy(alpha = 0.6f)))
                }
            }
        }
        ViewerOverlay(state, camera)

        Column(Modifier.align(Alignment.TopCenter).padding(12.dp).widthIn(max = 520.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            state.busy?.let { busy ->
                Surface(shape = RoundedCornerShape(14.dp), tonalElevation = 6.dp, shadowElevation = 4.dp) {
                    Row(Modifier.padding(start = 16.dp, end = 4.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(12.dp))
                        Text("${busy.label}…", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f, fill = false))
                        Spacer(Modifier.width(8.dp))
                        if (busy.cancellable) TextButton(onClick = { vm.cancelBusy() }) { Text("Cancel") }
                    }
                }
            }
            if (state.textures?.loading == true && state.hasTextures) {
                StatusPill("Decoding textures…", Tone.Neutral)
            }
        }

        state.glError?.let { err ->
            Surface(Modifier.align(Alignment.Center).padding(20.dp), shape = RoundedCornerShape(16.dp), tonalElevation = 6.dp) {
                Column(Modifier.padding(16.dp)) {
                    InfoBanner("The 3D view could not be drawn", body = "The graphics driver reported an error. The details below help to diagnose it.", tone = Tone.Bad)
                    Text(err, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall,
                         modifier = Modifier.padding(top = 10.dp).heightIn(max = 220.dp).verticalScroll(rememberScrollState())
                             .horizontalScroll(rememberScrollState()))
                }
            }
        }
    }
}
