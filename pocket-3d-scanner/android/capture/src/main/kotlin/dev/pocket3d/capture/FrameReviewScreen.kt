package dev.pocket3d.capture

import android.content.ActivityNotFoundException
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Sort
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.outlined.AddPhotoAlternate
import androidx.compose.material.icons.outlined.BlurOn
import androidx.compose.material.icons.outlined.BrokenImage
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.DarkMode
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.GpsOff
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.LinkOff
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material.icons.outlined.PhotoSizeSelectSmall
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material.icons.outlined.Speed
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material.icons.outlined.WbSunny
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.pocket3d.capture.logic.ReviewLogic
import dev.pocket3d.core.capture.FrameAnalysis
import dev.pocket3d.core.capture.ImageGeometry
import dev.pocket3d.core.net.StatusResponse
import dev.pocket3d.core.project.Frame
import dev.pocket3d.core.project.FrameFlag
import dev.pocket3d.core.services.Services
import dev.pocket3d.design.InfoBanner
import dev.pocket3d.design.LabeledValue
import dev.pocket3d.design.P3
import dev.pocket3d.design.SectionTitle
import dev.pocket3d.design.StatusPill
import dev.pocket3d.design.Tone
import java.io.File
import java.text.DateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.hypot
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/**
 * Review of a capture session's photos before reconstruction: flags, include/exclude, delete,
 * ordering, and adding more photos (system file picker or camera).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FrameReviewScreen(
    projectId: String,
    sessionId: String,
    onContinue: () -> Unit,
    onAddByCamera: () -> Unit,
    onBack: () -> Unit,
) {
    val vm: ReviewViewModel = viewModel(
        key = "review/$projectId/$sessionId",
        factory = viewModelFactory { initializer { ReviewViewModel(projectId, sessionId) } },
    )
    val state by vm.state.collectAsStateWithLifecycle()
    val limits = reviewCompanionLimits()
    val frames = state.frames
    val summary = remember(frames, limits) { ReviewLogic.summarize(frames, limits) }

    var selecting by rememberSaveable { mutableStateOf(false) }
    var selection by rememberSaveable(stateSaver = ReviewSelectionSaver) { mutableStateOf(emptySet<String>()) }
    var detailId by rememberSaveable { mutableStateOf<String?>(null) }
    var confirmDelete by rememberSaveable(stateSaver = ReviewIdListSaver) { mutableStateOf(emptyList<String>()) }
    var sortMenu by remember { mutableStateOf(false) }
    var moreMenu by remember { mutableStateOf(false) }
    val snackbar = remember { SnackbarHostState() }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) vm.importUris(uris.map { it.toString() })
    }
    val addPhotos: () -> Unit = {
        try {
            picker.launch(arrayOf("image/*"))
        } catch (e: ActivityNotFoundException) {
            vm.notify("No file picker is available on this device.")
        }
    }
    val exitSelection = { selecting = false; selection = emptySet() }

    // Drop selected / opened photos that no longer exist (deleted here or elsewhere).
    LaunchedEffect(frames, state.loading) {
        if (state.loading) return@LaunchedEffect
        val ids = frames.mapTo(HashSet()) { it.id }
        if (!ids.containsAll(selection)) selection = selection intersect ids
        if (detailId != null && detailId !in ids) detailId = null
        if (confirmDelete.any { it !in ids }) confirmDelete = confirmDelete.filter { it in ids }
        if (frames.isEmpty() && selecting) { selecting = false; selection = emptySet() }
    }

    val message = state.message
    LaunchedEffect(message?.id) {
        if (message == null) return@LaunchedEffect
        val undo = message.undoExcludeIds
        val result = snackbar.showSnackbar(
            message = message.text,
            actionLabel = if (undo.isNotEmpty()) "Undo" else null,
            duration = if (undo.isNotEmpty()) SnackbarDuration.Long else SnackbarDuration.Short,
        )
        if (result == SnackbarResult.ActionPerformed) vm.setExcluded(undo, excluded = false, announce = false)
        vm.consumeMessage(message.id)
    }

    BackHandler(enabled = selecting) { exitSelection() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(if (selecting) "${selection.size} selected" else "Review photos",
                         maxLines = 1, overflow = TextOverflow.Ellipsis)
                },
                navigationIcon = {
                    if (selecting) {
                        IconButton(onClick = exitSelection) { Icon(Icons.Filled.Close, "Cancel selection") }
                    } else {
                        IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                    }
                },
                actions = {
                    if (selecting) {
                        TextButton(onClick = { selection = frames.mapTo(LinkedHashSet()) { it.id } }) { Text("Select all") }
                    } else if (frames.isNotEmpty()) {
                        Box {
                            IconButton(onClick = { sortMenu = true }) {
                                Icon(Icons.AutoMirrored.Filled.Sort, "Photo order: ${ReviewLogic.orderingLabel(state.ordering)}. Change")
                            }
                            DropdownMenu(expanded = sortMenu, onDismissRequest = { sortMenu = false }) {
                                ReviewOrderMenuItem("Capture time", state.ordering == ReviewLogic.ORDER_TIME) {
                                    sortMenu = false; vm.setOrdering(ReviewLogic.ORDER_TIME)
                                }
                                ReviewOrderMenuItem("File name", state.ordering == ReviewLogic.ORDER_NAME) {
                                    sortMenu = false; vm.setOrdering(ReviewLogic.ORDER_NAME)
                                }
                            }
                        }
                        IconButton(onClick = { selecting = true }) { Icon(Icons.Outlined.Checklist, "Select photos") }
                        Box {
                            IconButton(onClick = { moreMenu = true }) { Icon(Icons.Filled.MoreVert, "More actions") }
                            DropdownMenu(expanded = moreMenu, onDismissRequest = { moreMenu = false }) {
                                DropdownMenuItem(
                                    text = { Text("Add photos") },
                                    leadingIcon = { Icon(Icons.Outlined.AddPhotoAlternate, null) },
                                    onClick = { moreMenu = false; addPhotos() },
                                )
                                DropdownMenuItem(
                                    text = { Text("Add with camera") },
                                    leadingIcon = { Icon(Icons.Outlined.PhotoCamera, null) },
                                    onClick = { moreMenu = false; onAddByCamera() },
                                )
                                DropdownMenuItem(
                                    text = { Text("Select all flagged (${summary.flaggedIncluded})") },
                                    leadingIcon = { Icon(Icons.Outlined.WarningAmber, null) },
                                    enabled = summary.flaggedIncluded > 0,
                                    onClick = {
                                        moreMenu = false
                                        selection = ReviewLogic.flaggedIncludedIds(frames).toSet()
                                        selecting = true
                                    },
                                )
                            }
                        }
                    }
                },
            )
        },
        bottomBar = {
            when {
                state.loading || state.session == null || frames.isEmpty() -> Unit
                selecting -> ReviewSelectionBar(
                    count = selection.size,
                    enabled = selection.isNotEmpty() && !state.busy,
                    onExclude = { vm.setExcluded(selection, true); exitSelection() },
                    onInclude = { vm.setExcluded(selection, false); exitSelection() },
                    onDelete = { confirmDelete = selection.toList() },
                )
                else -> ReviewContinueBar(summary, enabled = !state.busy && state.importProgress == null, onContinue = onContinue)
            }
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when {
                state.loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.semantics { contentDescription = "Loading photos" })
                }
                state.session == null -> ReviewEmptyState(
                    icon = Icons.Outlined.BrokenImage,
                    title = "Capture session not found",
                    body = "This set of photos no longer exists on the phone. It may have been deleted.",
                ) {
                    OutlinedButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) { Text("Go back") }
                }
                frames.isEmpty() -> ReviewEmptyState(
                    icon = Icons.Outlined.PhotoLibrary,
                    title = "No photos yet",
                    body = "Take photos while walking around the object, or add existing photos. " +
                        "Imported files are copied as they are, without recompression.",
                ) {
                    Button(onClick = onAddByCamera, modifier = Modifier.heightIn(min = 48.dp)) {
                        Icon(Icons.Outlined.PhotoCamera, null, Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Add with camera")
                    }
                    Spacer(Modifier.height(8.dp))
                    OutlinedButton(onClick = addPhotos, modifier = Modifier.heightIn(min = 48.dp)) {
                        Icon(Icons.Outlined.AddPhotoAlternate, null, Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Add photos")
                    }
                }
                else -> {
                    val targetPx = with(LocalDensity.current) { 132.dp.roundToPx() }.coerceIn(128, 384)
                    LazyVerticalGrid(
                        columns = GridCells.Adaptive(minSize = 104.dp),
                        contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 4.dp, bottom = 16.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        item(key = "review-header", span = { GridItemSpan(maxLineSpan) }) {
                            ReviewSummaryHeader(
                                summary = summary,
                                ordering = state.ordering,
                                busy = state.busy,
                                onExcludeFlagged = { vm.excludeAllFlagged() },
                                onSelectFlagged = {
                                    selection = ReviewLogic.flaggedIncludedIds(frames).toSet()
                                    selecting = true
                                },
                                onAddPhotos = addPhotos,
                                onAddByCamera = onAddByCamera,
                            )
                        }
                        itemsIndexed(frames, key = { _, f -> f.id }) { index, frame ->
                            val isSelected = frame.id in selection
                            ReviewFrameCell(
                                frame = frame, index = index, total = frames.size, file = vm.fileOf(frame),
                                targetPx = targetPx, selecting = selecting, selected = isSelected,
                                onClick = {
                                    if (selecting) selection = if (isSelected) selection - frame.id else selection + frame.id
                                    else detailId = frame.id
                                },
                                onLongClick = {
                                    if (!selecting) { selecting = true; selection = setOf(frame.id) }
                                    else selection = if (isSelected) selection - frame.id else selection + frame.id
                                },
                            )
                        }
                    }
                }
            }
        }
    }

    // --- detail sheet ---------------------------------------------------------------------------
    val detailIndex = if (detailId == null) -1 else frames.indexOfFirst { it.id == detailId }
    if (detailIndex >= 0) {
        val frame = frames[detailIndex]
        ModalBottomSheet(
            onDismissRequest = { detailId = null },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        ) {
            ReviewDetailContent(
                frame = frame, index = detailIndex, total = frames.size, file = vm.fileOf(frame), busy = state.busy,
                onToggleExcluded = { vm.setExcluded(listOf(frame.id), !frame.excluded, announce = false) },
                onDelete = { confirmDelete = listOf(frame.id) },
            )
        }
    }

    // --- delete confirmation --------------------------------------------------------------------
    if (confirmDelete.isNotEmpty()) {
        val ids = confirmDelete
        val n = ids.size
        AlertDialog(
            onDismissRequest = { confirmDelete = emptyList() },
            icon = { Icon(Icons.Outlined.Delete, null) },
            title = { Text(if (n == 1) "Delete this photo?" else "Delete $n photos?") },
            text = {
                Text("The original ${if (n == 1) "file is" else "files are"} removed from this phone and cannot be restored. " +
                     "To only leave ${if (n == 1) "it" else "them"} out of the reconstruction, exclude instead — excluded photos stay on the phone.")
            },
            confirmButton = {
                TextButton(onClick = {
                    vm.delete(ids)
                    confirmDelete = emptyList()
                    detailId = null
                    exitSelection()
                }) { Text("Delete", color = P3.colors.bad) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = emptyList() }) { Text("Cancel") } },
        )
    }

    // --- import progress / result ---------------------------------------------------------------
    val progress = state.importProgress
    val importResult = state.importResult
    if (progress != null) {
        AlertDialog(
            onDismissRequest = {},
            confirmButton = {},
            title = { Text("Adding photos") },
            text = {
                Column {
                    val fraction = if (progress.total > 0) progress.done.toFloat() / progress.total else 0f
                    LinearProgressIndicator(
                        progress = { fraction.coerceIn(0f, 1f) },
                        modifier = Modifier.fillMaxWidth().semantics {
                            contentDescription = "${progress.done} of ${progress.total} files processed"
                        },
                    )
                    Spacer(Modifier.height(12.dp))
                    Text("${progress.done} of ${progress.total} files processed", style = MaterialTheme.typography.bodyMedium)
                    Spacer(Modifier.height(4.dp))
                    Text("Each file is copied as it is (no recompression), then checked.",
                         style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            },
        )
    } else if (importResult != null) {
        ReviewImportResultDialog(importResult, onDismiss = { vm.dismissImportResult() })
    }
}

// ------------------------------------------------------------------------------------------------

private val ReviewSelectionSaver = listSaver<Set<String>, String>(save = { it.toList() }, restore = { it.toSet() })
private val ReviewIdListSaver = listSaver<List<String>, String>(save = { ArrayList(it) }, restore = { it.toList() })

/** Limits of the paired companion if its status is known, else null. Safe without `Services`. */
@Composable
private fun reviewCompanionLimits(): StatusResponse.Limits? {
    val link = remember { try { Services.companion } catch (e: UninitializedPropertyAccessException) { null } }
    return if (link != null) {
        val companion by link.state.collectAsStateWithLifecycle()
        companion.status?.limits
    } else null
}

private fun reviewFlagIcon(flag: String): ImageVector = when (flag) {
    FrameFlag.BLUR -> Icons.Outlined.BlurOn
    FrameFlag.DARK -> Icons.Outlined.DarkMode
    FrameFlag.OVEREXPOSED -> Icons.Outlined.WbSunny
    FrameFlag.DUPLICATE -> Icons.Outlined.ContentCopy
    FrameFlag.LOW_OVERLAP -> Icons.Outlined.LinkOff
    FrameFlag.TRACKING_LOST -> Icons.Outlined.GpsOff
    FrameFlag.FAST_MOTION -> Icons.Outlined.Speed
    FrameFlag.LOW_RESOLUTION -> Icons.Outlined.PhotoSizeSelectSmall
    FrameFlag.NO_METADATA -> Icons.Outlined.Info
    else -> Icons.Outlined.WarningAmber
}

@Composable
private fun ReviewOrderMenuItem(label: String, selected: Boolean, onClick: () -> Unit) {
    DropdownMenuItem(
        text = { Text(label) },
        leadingIcon = {
            if (selected) Icon(Icons.Outlined.Check, null) else Spacer(Modifier.size(24.dp))
        },
        onClick = onClick,
        modifier = Modifier.semantics {
            this.selected = selected
            stateDescription = if (selected) "Current order" else "Not selected"
        },
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ReviewSummaryHeader(
    summary: ReviewLogic.Summary,
    ordering: String,
    busy: Boolean,
    onExcludeFlagged: () -> Unit,
    onSelectFlagged: () -> Unit,
    onAddPhotos: () -> Unit,
    onAddByCamera: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(bottom = 10.dp)) {
        Text(
            "${summary.included} of ${summary.total} ${if (summary.total == 1) "photo" else "photos"} included",
            style = MaterialTheme.typography.headlineSmall,
            modifier = Modifier.semantics { heading() },
        )
        Spacer(Modifier.height(2.dp))
        Text(
            "Only included photos are sent to the companion computer. Excluded photos stay on the phone. " +
                "Sorted by ${ReviewLogic.orderingLabel(ordering).lowercase(Locale.ROOT)}.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(10.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (summary.excluded > 0) {
                StatusPill("Excluded · ${summary.excluded}", Tone.Neutral, icon = Icons.Outlined.VisibilityOff)
            }
            if (summary.flagCounts.isEmpty()) {
                StatusPill("No quality flags on included photos", Tone.Good, icon = Icons.Outlined.Check)
            } else {
                for ((flag, count) in summary.flagCounts) {
                    StatusPill(
                        "${ReviewLogic.shortFlagLabel(flag)} · $count", Tone.Warn, icon = reviewFlagIcon(flag),
                        modifier = Modifier.semantics {
                            contentDescription = "$count included ${if (count == 1) "photo" else "photos"}: ${FrameFlag.describe(flag)}"
                        },
                    )
                }
            }
            StatusPill(summary.limitsText, if (summary.limitsFromCompanion) Tone.Companion else Tone.Neutral)
        }
        for (notice in summary.notices) {
            Spacer(Modifier.height(8.dp))
            InfoBanner(
                title = notice.title, body = notice.body,
                tone = when (notice.severity) {
                    ReviewLogic.Severity.BLOCK -> Tone.Bad
                    ReviewLogic.Severity.WARN -> Tone.Warn
                    ReviewLogic.Severity.INFO -> Tone.Neutral
                },
            )
        }
        if (summary.flaggedIncluded > 0) {
            Spacer(Modifier.height(8.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilledTonalButton(onClick = onExcludeFlagged, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) {
                    Icon(Icons.Outlined.VisibilityOff, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Exclude ${summary.flaggedIncluded} flagged")
                }
                TextButton(onClick = onSelectFlagged, modifier = Modifier.heightIn(min = 48.dp)) { Text("Select flagged") }
            }
        }
        Spacer(Modifier.height(8.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onAddPhotos, modifier = Modifier.heightIn(min = 48.dp)) {
                Icon(Icons.Outlined.AddPhotoAlternate, null, Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Add photos")
            }
            OutlinedButton(onClick = onAddByCamera, modifier = Modifier.heightIn(min = 48.dp)) {
                Icon(Icons.Outlined.PhotoCamera, null, Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Add with camera")
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ReviewFrameCell(
    frame: Frame,
    index: Int,
    total: Int,
    file: File?,
    targetPx: Int,
    selecting: Boolean,
    selected: Boolean,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    val shape = MaterialTheme.shapes.small
    val flags = frame.flags.distinct()
    val description = buildString {
        append("Photo ${index + 1} of $total, ${frame.name}")
        if (flags.isNotEmpty()) append(". Flags: ").append(flags.joinToString("; ") { FrameFlag.describe(it) })
    }
    val stateText = buildString {
        append(if (frame.excluded) "Excluded from reconstruction" else "Included in reconstruction")
        if (selecting) append(if (selected) ", selected" else ", not selected")
    }
    Box(
        Modifier
            .aspectRatio(1f)
            .clip(shape)
            .then(if (selected) Modifier.border(3.dp, MaterialTheme.colorScheme.primary, shape) else Modifier)
            .combinedClickable(
                onClick = onClick,
                onLongClick = onLongClick,
                onClickLabel = if (selecting) (if (selected) "Deselect" else "Select") else "Show details",
                onLongClickLabel = if (selecting) null else "Select",
            )
            .clearAndSetSemantics {
                contentDescription = description
                stateDescription = stateText
                if (selecting) this.selected = selected
            },
    ) {
        if (file != null) {
            FrameThumbnail(file, frame.exifOrientation, Modifier.fillMaxSize(), targetPx)
        } else {
            Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceVariant))
        }
        if (frame.excluded) {
            Box(Modifier.fillMaxSize().background(P3.colors.scrim), contentAlignment = Alignment.Center) {
                Surface(color = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f), shape = RoundedCornerShape(50)) {
                    Row(Modifier.padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.VisibilityOff, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurface)
                        Spacer(Modifier.width(4.dp))
                        Text("Excluded", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurface)
                    }
                }
            }
        }
        if (flags.isNotEmpty()) {
            Surface(
                color = MaterialTheme.colorScheme.surface.copy(alpha = 0.90f), shape = RoundedCornerShape(6.dp),
                modifier = Modifier.align(Alignment.BottomStart).padding(4.dp),
            ) {
                Row(Modifier.padding(horizontal = 5.dp, vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(reviewFlagIcon(flags.first()), null, Modifier.size(14.dp), tint = P3.colors.warn)
                    Spacer(Modifier.width(4.dp))
                    Text(
                        ReviewLogic.shortFlagLabel(flags.first()),
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurface,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                    )
                    if (flags.size > 1) {
                        Text(" +${flags.size - 1}", style = MaterialTheme.typography.labelSmall,
                             color = MaterialTheme.colorScheme.onSurface, maxLines = 1)
                    }
                }
            }
        }
        if (selecting) {
            Box(
                Modifier.align(Alignment.TopStart).padding(5.dp).size(24.dp)
                    .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.90f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                if (selected) Icon(Icons.Filled.CheckCircle, null, Modifier.size(24.dp), tint = MaterialTheme.colorScheme.primary)
                else Icon(Icons.Outlined.RadioButtonUnchecked, null, Modifier.size(24.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun ReviewContinueBar(summary: ReviewLogic.Summary, enabled: Boolean, onContinue: () -> Unit) {
    Surface(tonalElevation = 3.dp) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp, vertical = 10.dp)) {
            val reason = summary.blockReason
            if (reason != null) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 8.dp)) {
                    Icon(Icons.Outlined.ErrorOutline, null, Modifier.size(18.dp), tint = P3.colors.bad)
                    Spacer(Modifier.width(8.dp))
                    Text(reason, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface)
                }
            }
            Button(
                onClick = onContinue,
                enabled = enabled && summary.canContinue,
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).semantics {
                    if (reason != null) stateDescription = "Unavailable: $reason"
                },
            ) {
                Text("Continue with ${summary.included} ${if (summary.included == 1) "photo" else "photos"}")
            }
        }
    }
}

@Composable
private fun ReviewSelectionBar(count: Int, enabled: Boolean, onExclude: () -> Unit, onInclude: () -> Unit, onDelete: () -> Unit) {
    Surface(tonalElevation = 3.dp) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 8.dp, vertical = 6.dp)) {
            if (count == 0) {
                Text("Tap photos to select them.", style = MaterialTheme.typography.bodySmall,
                     color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp))
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                TextButton(onClick = onExclude, enabled = enabled, modifier = Modifier.weight(1f).heightIn(min = 52.dp)) {
                    Icon(Icons.Outlined.VisibilityOff, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Exclude", maxLines = 1)
                }
                TextButton(onClick = onInclude, enabled = enabled, modifier = Modifier.weight(1f).heightIn(min = 52.dp)) {
                    Icon(Icons.Outlined.Visibility, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Include", maxLines = 1)
                }
                TextButton(onClick = onDelete, enabled = enabled, modifier = Modifier.weight(1f).heightIn(min = 52.dp)) {
                    Icon(Icons.Outlined.Delete, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Delete", maxLines = 1)
                }
            }
        }
    }
}

@Composable
private fun ReviewEmptyState(icon: ImageVector, title: String, body: String, actions: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        Icon(icon, null, Modifier.size(56.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(16.dp))
        Text(title, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center,
             modifier = Modifier.semantics { heading() })
        Spacer(Modifier.height(8.dp))
        Text(body, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center,
             color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(24.dp))
        actions()
    }
}

// --- detail sheet -----------------------------------------------------------------------------

@Composable
private fun ReviewDetailContent(
    frame: Frame,
    index: Int,
    total: Int,
    file: File?,
    busy: Boolean,
    onToggleExcluded: () -> Unit,
    onDelete: () -> Unit,
) {
    val (quarterTurns, mirrored) = ImageGeometry.exifQuarterTurns(frame.exifOrientation)
    val (uprightW, uprightH) = ImageGeometry.uprightSize(frame.width, frame.height, quarterTurns)
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 28.dp)) {
        Text(frame.name, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis,
             modifier = Modifier.semantics { heading() })
        Spacer(Modifier.height(4.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Photo ${index + 1} of $total", style = MaterialTheme.typography.bodySmall,
                 color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(10.dp))
            if (frame.excluded) StatusPill("Excluded from reconstruction", Tone.Neutral, icon = Icons.Outlined.VisibilityOff)
            else StatusPill("Included", Tone.Good, icon = Icons.Outlined.Check)
        }
        Spacer(Modifier.height(12.dp))
        ReviewLargePreview(file, frame, uprightW, uprightH)

        Spacer(Modifier.height(12.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilledTonalButton(onClick = onToggleExcluded, enabled = !busy, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
                Icon(if (frame.excluded) Icons.Outlined.Visibility else Icons.Outlined.VisibilityOff, null, Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text(if (frame.excluded) "Include" else "Exclude", maxLines = 1)
            }
            OutlinedButton(onClick = onDelete, enabled = !busy, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
                Icon(Icons.Outlined.Delete, null, Modifier.size(18.dp), tint = P3.colors.bad)
                Spacer(Modifier.width(8.dp))
                Text("Delete", maxLines = 1)
            }
        }
        Text(
            if (frame.excluded) "Excluded: kept on the phone, not sent to the companion computer."
            else "Exclude keeps the file on the phone; delete removes it.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 6.dp),
        )

        SectionTitle("Flags")
        val flags = frame.flags.distinct()
        if (flags.isEmpty()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Check, null, Modifier.size(18.dp), tint = P3.colors.good)
                Spacer(Modifier.width(8.dp))
                Text("No issues found by the on-phone checks.", style = MaterialTheme.typography.bodyMedium)
            }
        } else {
            for (flag in flags) {
                Row(Modifier.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(reviewFlagIcon(flag), null, Modifier.size(18.dp), tint = P3.colors.warn)
                    Spacer(Modifier.width(8.dp))
                    Text(FrameFlag.describe(flag), style = MaterialTheme.typography.bodyMedium)
                }
            }
        }

        SectionTitle("Image")
        LabeledValue("Resolution", reviewResolutionText(uprightW, uprightH))
        LabeledValue("Stored as", reviewStoredText(frame, quarterTurns, mirrored))
        LabeledValue("Captured", frame.timestampMs?.let { reviewFormatTime(it) } ?: "Unknown")
        LabeledValue("File", "${frame.format.uppercase(Locale.ROOT)} · ${reviewFormatBytes(frame.sizeBytes)}")

        SectionTitle("Camera")
        val k = frame.intrinsics
        LabeledValue("Focal length", reviewFocalText(frame))
        LabeledValue("Intrinsics source", when (val source = k?.source) {
            "arcore" -> "AR tracking (ARCore)"
            "camera2" -> "Device calibration"
            "exif" -> "EXIF focal length"
            null -> "None"
            else -> source
        }, tone = if (k == null) Tone.Warn else Tone.Neutral)
        if (k == null) {
            Text("Without a focal length the reconstruction has to estimate it from the photos, which is less reliable.",
                 style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        LabeledValue("Lens distortion", if (frame.distortion?.k?.isNotEmpty() == true) "Reported by device" else "Not reported")
        LabeledValue("Focus", frame.focus?.let { f ->
            (if (f.locked) "Locked" else "Auto") + (f.distanceDiopters?.takeIf { it > 0.0 }?.let {
                String.format(Locale.US, " · %.2f m", 1.0 / it)
            } ?: "")
        } ?: "Not recorded")
        LabeledValue("Exposure", frame.exposure?.let { e ->
            listOfNotNull(if (e.locked) "Locked" else "Auto", e.iso?.let { "ISO $it" }, e.exposureNs?.let { reviewShutterText(it) })
                .joinToString(" · ")
        } ?: "Not recorded")

        SectionTitle("Quality (measured on the phone)")
        val q = frame.quality
        val sharp = q.sharpness
        LabeledValue(
            "Sharpness", sharp?.let { String.format(Locale.US, "%.0f (blurry below %.0f)", it, FrameAnalysis.BLUR_THRESHOLD) } ?: "Not measured",
            tone = if (sharp != null && sharp < FrameAnalysis.BLUR_THRESHOLD) Tone.Warn else Tone.Neutral,
        )
        LabeledValue(
            "Mean brightness", q.meanLuma?.let { String.format(Locale.US, "%.0f / 255", it) } ?: "Not measured",
            tone = if (q.meanLuma != null && q.meanLuma!! < FrameAnalysis.DARK_MEAN_LUMA) Tone.Warn else Tone.Neutral,
        )
        LabeledValue(
            "Clipped shadows", q.clippedLow?.let { reviewPercent(it) } ?: "Not measured",
            tone = if (q.clippedLow != null && q.clippedLow!! > FrameAnalysis.CLIPPED_LOW_LIMIT) Tone.Warn else Tone.Neutral,
        )
        LabeledValue(
            "Clipped highlights", q.clippedHigh?.let { reviewPercent(it) } ?: "Not measured",
            tone = if (q.clippedHigh != null && q.clippedHigh!! > FrameAnalysis.CLIPPED_HIGH_LIMIT) Tone.Warn else Tone.Neutral,
        )
        LabeledValue("Overlap with previous view", q.overlap?.let { "≈ ${(it * 100).roundToInt()} % (estimate)" } ?: "Not estimated")

        SectionTitle("Tracking")
        val pose = frame.pose
        LabeledValue("AR camera pose", if (pose != null) "Recorded" else "None")
        LabeledValue("Tracking segment", pose?.let { "#${it.segment + 1}" } ?: "—")
        Text(
            if (pose != null) "AR poses are only used to validate the reconstruction and estimate real-world scale; " +
                "camera positions are always re-computed from the photos on the companion computer."
            else "No tracked position for this photo. Its camera position is computed from the photo itself during reconstruction.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ReviewLargePreview(file: File?, frame: Frame, uprightW: Int, uprightH: Int) {
    val ratio = if (uprightW > 0 && uprightH > 0) (uprightW.toFloat() / uprightH).coerceIn(0.45f, 2.4f) else 4f / 3f
    val path = file?.path
    var bitmap by remember(path, frame.exifOrientation) {
        mutableStateOf<ImageBitmap?>(file?.let { ThumbnailLoader.peek(it, frame.exifOrientation, REVIEW_PREVIEW_PX) })
    }
    var failed by remember(path, frame.exifOrientation) { mutableStateOf(file == null) }
    LaunchedEffect(path, frame.exifOrientation) {
        if (file == null) return@LaunchedEffect
        val loaded = ThumbnailLoader.load(file, frame.exifOrientation, REVIEW_PREVIEW_PX)
        bitmap = loaded
        failed = loaded == null
    }
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Box(
            Modifier.heightIn(max = 340.dp).aspectRatio(ratio).clip(MaterialTheme.shapes.medium)
                .background(MaterialTheme.colorScheme.surfaceVariant),
            contentAlignment = Alignment.Center,
        ) {
            val b = bitmap
            when {
                b != null -> Image(b, contentDescription = "Preview of ${frame.name}", modifier = Modifier.fillMaxSize(),
                                   contentScale = ContentScale.Fit)
                failed -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Outlined.BrokenImage, null, Modifier.size(32.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(6.dp))
                    Text("Preview not available", style = MaterialTheme.typography.bodySmall,
                         color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                else -> CircularProgressIndicator(Modifier.size(28.dp).semantics { contentDescription = "Loading preview" })
            }
        }
    }
}

/** Shorter-side target of the detail preview decode (a down-sampled preview, not the original). */
private const val REVIEW_PREVIEW_PX = 720

@Composable
private fun ReviewImportResultDialog(result: ReviewImportResult, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = { TextButton(onClick = onDismiss) { Text("OK") } },
        title = { Text(if (result.error != null) "Import failed" else "Import finished") },
        text = {
            Column(Modifier.heightIn(max = 380.dp).verticalScroll(rememberScrollState())) {
                if (result.error != null) {
                    Row(verticalAlignment = Alignment.Top) {
                        Icon(Icons.Outlined.ErrorOutline, null, Modifier.size(18.dp), tint = P3.colors.bad)
                        Spacer(Modifier.width(8.dp))
                        Text(result.error, style = MaterialTheme.typography.bodyMedium)
                    }
                    Spacer(Modifier.height(8.dp))
                    Text("Photos copied before the failure, if any, are in the list.",
                         style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            if (result.imported > 0) Icons.Outlined.Check else Icons.Outlined.WarningAmber, null, Modifier.size(18.dp),
                            tint = if (result.imported > 0) P3.colors.good else P3.colors.warn,
                        )
                        Spacer(Modifier.width(8.dp))
                        Text("${result.imported} of ${result.requested} ${if (result.requested == 1) "file" else "files"} added",
                             style = MaterialTheme.typography.bodyMedium)
                    }
                    if (result.issues.isNotEmpty()) {
                        Spacer(Modifier.height(12.dp))
                        Text("Not added (${result.issues.size})", style = MaterialTheme.typography.titleSmall,
                             modifier = Modifier.semantics { heading() })
                        for (issue in result.issues) {
                            HorizontalDivider(Modifier.padding(vertical = 6.dp))
                            Row(
                                verticalAlignment = Alignment.Top,
                                modifier = Modifier.semantics(mergeDescendants = true) {},
                            ) {
                                Icon(Icons.Outlined.ErrorOutline, null, Modifier.size(18.dp), tint = P3.colors.bad)
                                Spacer(Modifier.width(8.dp))
                                Column {
                                    Text(issue.sourceName.ifBlank { "Unnamed file" }, style = MaterialTheme.typography.bodyMedium,
                                         maxLines = 2, overflow = TextOverflow.Ellipsis)
                                    Text(issue.reason, style = MaterialTheme.typography.bodySmall,
                                         color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                    }
                }
            }
        },
    )
}

// --- formatting ---------------------------------------------------------------------------------

private fun reviewResolutionText(w: Int, h: Int): String =
    if (w <= 0 || h <= 0) "Unknown"
    else String.format(Locale.US, "%d × %d (%.1f MP)", w, h, w.toLong() * h / 1e6)

private fun reviewStoredText(frame: Frame, quarterTurns: Int, mirrored: Boolean): String {
    if (frame.width <= 0 || frame.height <= 0) return "EXIF ${frame.exifOrientation}"
    val how = when {
        quarterTurns == 0 && !mirrored -> "upright"
        mirrored && quarterTurns == 0 -> "mirrored"
        mirrored -> "mirrored, shown turned ${quarterTurns * 90}°"
        else -> "shown turned ${quarterTurns * 90}°"
    }
    return "${frame.width} × ${frame.height}, $how"
}

private fun reviewFocalText(frame: Frame): String {
    val k = frame.intrinsics ?: return "Unknown"
    val px = (k.fx + k.fy) / 2.0
    if (frame.width <= 0 || frame.height <= 0) return String.format(Locale.US, "%.0f px", px)
    val equiv = px * 43.27 / hypot(frame.width.toDouble(), frame.height.toDouble())
    return String.format(Locale.US, "%.0f px (≈ %.0f mm equiv.)", px, equiv)
}

private fun reviewShutterText(exposureNs: Long): String {
    if (exposureNs <= 0) return "—"
    val seconds = exposureNs / 1e9
    return if (seconds >= 0.5) String.format(Locale.US, "%.1f s", seconds) else "1/${(1.0 / seconds).roundToLong()} s"
}

private fun reviewPercent(fraction: Double): String = String.format(Locale.US, "%.1f %%", fraction * 100.0)

private fun reviewFormatTime(ms: Long): String =
    DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.MEDIUM).format(Date(ms))

private fun reviewFormatBytes(bytes: Long): String = when {
    bytes <= 0 -> "size unknown"
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> String.format(Locale.US, "%.0f kB", bytes / 1024.0)
    else -> String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0))
}
