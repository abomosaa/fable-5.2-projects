package dev.pocket3d.app.ui

import android.widget.Toast
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.AddPhotoAlternate
import androidx.compose.material.icons.outlined.CameraAlt
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.HelpOutline
import androidx.compose.material.icons.outlined.ViewInAr
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pocket3d.core.net.PresetInfo
import dev.pocket3d.core.project.CaptureSession
import dev.pocket3d.core.project.CaptureSource
import dev.pocket3d.core.project.ModelVersion
import dev.pocket3d.core.project.Project
import dev.pocket3d.core.project.ReconJob
import dev.pocket3d.core.services.Services
import dev.pocket3d.design.InfoBanner
import dev.pocket3d.design.SectionTitle
import dev.pocket3d.design.StatusPill
import dev.pocket3d.design.Tone
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

private val DEFAULT_PRESETS = listOf(
    PresetInfo("preview", "Preview", "Fast, coarse check that the capture registers and roughly reconstructs. Low detail; not for export."),
    PresetInfo("standard", "Standard", "Balanced detail and time. Recommended for most objects."),
    PresetInfo("high", "High", "Maximum detail: larger depth maps, photometric mesh refinement and an 8K texture. Several times slower."),
)

private class ProjectData(val project: Project?, val sessions: List<CaptureSession>, val jobs: List<ReconJob>,
                          val models: List<ModelVersion>, val loaded: Boolean)

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ProjectScreen(projectId: String, onBack: () -> Unit, onGuide: () -> Unit, onCapture: (sessionId: String?) -> Unit,
                  onImport: (sessionId: String?) -> Unit, onReview: (sessionId: String) -> Unit, onOpenJob: (String) -> Unit,
                  onOpenModel: (String) -> Unit, onOpenAr: (String) -> Unit, onOpenPairing: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val companion by Services.companion.state.collectAsStateWithLifecycle()
    // Everything is re-read whenever the project record or the library summary changes (jobs
    // progress through the summaries flow), so the screen reflects persisted state only.
    val summaries by Services.store.summaries.collectAsStateWithLifecycle()
    val data by produceState(ProjectData(null, emptyList(), emptyList(), emptyList(), false), projectId) {
        Services.store.observeProject(projectId).collectLatest { p ->
            value = if (p == null) ProjectData(null, emptyList(), emptyList(), emptyList(), true)
            else ProjectData(p, Services.store.sessions(projectId), Services.store.jobs(projectId).sortedByDescending { it.createdAtMs },
                             Services.store.models(projectId).sortedByDescending { it.createdAtMs }, true)
        }
    }
    val liveJobs by produceState(data.jobs, data, summaries) {
        value = if (data.project != null) Services.store.jobs(projectId).sortedByDescending { it.createdAtMs } else emptyList()
    }
    val liveSessions by produceState(data.sessions, data, summaries) {
        value = if (data.project != null) Services.store.sessions(projectId) else emptyList()
    }
    LaunchedEffect(Unit) { Services.companion.refresh() }
    var preset by rememberSaveable { mutableStateOf("standard") }
    var selectedSession by rememberSaveable { mutableStateOf<String?>(null) }
    var deleteModel by remember { mutableStateOf<ModelVersion?>(null) }
    var starting by remember { mutableStateOf(false) }

    val project = data.project
    Scaffold(topBar = {
        TopAppBar(title = { Text(project?.name ?: "Project", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                  navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") } },
                  actions = { IconButton(onClick = onGuide) { Icon(Icons.Outlined.HelpOutline, "How to capture") } })
    }) { pad ->
        if (data.loaded && project == null) {
            Box(Modifier.padding(pad).fillMaxSize(), contentAlignment = Alignment.Center) { Text("This project no longer exists.") }
            return@Scaffold
        }
        if (project == null) {
            Box(Modifier.padding(pad).fillMaxSize(), contentAlignment = Alignment.Center) { LinearProgressIndicator() }
            return@Scaffold
        }
        val sessions = liveSessions.sortedByDescending { it.createdAtMs }
        val session = sessions.firstOrNull { it.id == selectedSession } ?: sessions.firstOrNull { it.includedFrames.isNotEmpty() } ?: sessions.firstOrNull()
        LazyColumn(Modifier.padding(pad).fillMaxSize(), contentPadding = PaddingValues(16.dp, 0.dp, 16.dp, 32.dp)) {
            // ---------------------------------------------------------------- photos
            item { SectionTitle("1 · Photos (on this phone)") }
            if (sessions.isEmpty()) item {
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("No photos yet", style = MaterialTheme.typography.titleMedium)
                        Text("Capture 30–80 overlapping photos while walking around the object, or import a photo set you already have.",
                             style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = onGuide) { Icon(Icons.Outlined.CameraAlt, null); Spacer(Modifier.width(8.dp)); Text("Capture") }
                            OutlinedButton(onClick = { onImport(null) }) { Icon(Icons.Outlined.AddPhotoAlternate, null); Spacer(Modifier.width(8.dp)); Text("Import") }
                        }
                    }
                }
            }
            sessions.forEach { s ->
                item(key = "s-${s.id}") {
                    SessionCard(s, selected = s.id == session?.id, multiple = sessions.size > 1, onSelect = { selectedSession = s.id },
                                onReview = { onReview(s.id) }, onCapture = { onCapture(s.id) }, onImport = { onImport(s.id) })
                    Spacer(Modifier.height(8.dp))
                }
            }
            if (sessions.isNotEmpty()) item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { onCapture(null) }) { Text("New capture session") }
                    TextButton(onClick = { onImport(null) }) { Text("Import another set") }
                }
                Text("Each capture session is reconstructed on its own: separate sessions are never merged into one " +
                         "coordinate system without shared geometry.", style = MaterialTheme.typography.bodySmall,
                     color = MaterialTheme.colorScheme.onSurfaceVariant)
            }

            // ---------------------------------------------------------------- reconstruction
            item {
                SectionTitle("2 · Reconstruct", trailing = { StatusPill("Runs on companion computer", Tone.Companion) })
            }
            item {
                val (ctext, ctone) = companionSummary(companion)
                val limits = companion.status?.limits
                val presets = companion.status?.presets?.takeIf { it.isNotEmpty() } ?: DEFAULT_PRESETS
                val included = session?.includedFrames?.size ?: 0
                val minImages = limits?.minImages ?: 3
                val activeJob = liveJobs.firstOrNull { it.phase.isActive }
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            StatusPill(ctext, ctone, Modifier.clickable(onClick = onOpenPairing))
                            companion.status?.let { st ->
                                Text("${st.resources.jobThreads} threads · ${"%.1f".format(st.resources.jobMemoryMb / 1024.0)} GB per job · " +
                                         (st.hardware.gpu ?: "CPU only"),
                                     style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        if (!companion.paired) {
                            InfoBanner("Pair a companion computer", tone = Tone.Warn,
                                       body = "Dense photogrammetry needs desktop compute. Run the bundled companion on a computer in your " +
                                           "local network and pair it once. Photos are sent only to that computer, over an encrypted, pinned connection.",
                                       actionLabel = "Pair now", onAction = onOpenPairing)
                        }
                        Text("Quality", style = MaterialTheme.typography.labelLarge)
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            presets.forEach { p -> FilterChip(selected = preset == p.id, onClick = { preset = p.id }, label = { Text(p.label) }) }
                        }
                        Text(presets.firstOrNull { it.id == preset }?.description ?: "", style = MaterialTheme.typography.bodySmall,
                             color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (session != null && included in 1 until 20) {
                            InfoBanner("Only ${photos(included)} selected", tone = Tone.Warn,
                                       body = "That is usually too few for a complete model. 30–80 overlapping photos work best.")
                        }
                        if (limits != null && included > limits.maxImages) {
                            InfoBanner("Too many photos for this companion", tone = Tone.Bad,
                                       body = "It accepts at most ${limits.maxImages} photos per job. Exclude some in the photo review.")
                        }
                        val canStart = companion.paired && session != null && included >= minImages &&
                            (limits == null || included <= limits.maxImages) && activeJob == null && !starting
                        Button(enabled = canStart, modifier = Modifier.fillMaxWidth(), onClick = {
                            val s = session ?: return@Button
                            starting = true
                            scope.launch {
                                val r = runCatching { Services.reconstruction.startJob(projectId, s.id, preset, s.includedFrames.map { it.id }) }
                                starting = false
                                withContext(Dispatchers.Main.immediate) {
                                    r.onSuccess { onOpenJob(it.id) }
                                        .onFailure { toast(context, "Could not start: ${it.message}") }
                                }
                            }
                        }) {
                            Text(when {
                                activeJob != null -> "A reconstruction is already in progress"
                                session == null || included == 0 -> "Add photos first"
                                included < minImages -> "At least $minImages photos needed"
                                else -> "Reconstruct ${photos(included)}"
                            })
                        }
                        if (project.activeModelId != null) {
                            Text("Your current model stays untouched and active until a new reconstruction has finished and been verified.",
                                 style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
            liveJobs.forEach { j ->
                item(key = "j-${j.id}") {
                    Spacer(Modifier.height(8.dp))
                    JobRow(j, onClick = { onOpenJob(j.id) })
                }
            }

            // ---------------------------------------------------------------- models
            item { SectionTitle("3 · Models") }
            if (data.models.isEmpty()) item {
                Text("No model yet. A model appears here only after a reconstruction has completed and its files were verified.",
                     style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            data.models.forEach { m ->
                item(key = "m-${m.id}") {
                    ModelCard(projectId, m, active = m.id == project.activeModelId, onOpen = { onOpenModel(m.id) }, onAr = { onOpenAr(m.id) },
                              onSetActive = { scope.launch { Services.store.setActiveModel(projectId, m.id) } },
                              onDelete = { deleteModel = m })
                    Spacer(Modifier.height(8.dp))
                }
            }
        }
    }
    deleteModel?.let { m ->
        AlertDialog(onDismissRequest = { deleteModel = null }, title = { Text("Delete this model?") },
                    text = { Text("Removes this reconstruction result (${formatBytes(m.glbBytes)}) with its edits and measurements from the " +
                                      "phone. Source photos and other models are kept.") },
                    confirmButton = { TextButton(onClick = { deleteModel = null; scope.launch { Services.store.deleteModel(projectId, m.id) } }) {
                        Text("Delete", color = MaterialTheme.colorScheme.error) } },
                    dismissButton = { TextButton(onClick = { deleteModel = null }) { Text("Cancel") } })
    }
}

@Composable
private fun SessionCard(s: CaptureSession, selected: Boolean, multiple: Boolean, onSelect: () -> Unit, onReview: () -> Unit,
                        onCapture: () -> Unit, onImport: () -> Unit) {
    val flagged = s.frames.count { it.flags.isNotEmpty() && !it.excluded }
    val excluded = s.frames.count { it.excluded }
    val bytes = s.frames.sumOf { it.sizeBytes }
    Card(onClick = onSelect, colors = CardDefaults.cardColors(
        containerColor = if (selected && multiple) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceContainer)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(when (s.source) {
                    CaptureSource.CAMERA_AR -> "Camera capture · AR tracked"
                    CaptureSource.CAMERA -> "Camera capture"
                    CaptureSource.IMPORT -> "Imported photos"
                }, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                if (selected && multiple) StatusPill("Selected", Tone.Good)
            }
            Text("${photos(s.includedFrames.size)} to use · ${formatBytes(bytes)} · ${formatDate(s.createdAtMs)}",
                 style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (flagged > 0) StatusPill("$flagged flagged", Tone.Warn)
                if (excluded > 0) StatusPill("$excluded excluded", Tone.Neutral)
                when (s.tracking.mode) {
                    "arcore" -> StatusPill("Viewpoints tracked" + if (s.tracking.segments.size > 1) " · ${s.tracking.segments.size} segments" else "", Tone.Good)
                    "imu" -> StatusPill("Viewpoints estimated", Tone.Provisional)
                    else -> {}
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onReview) { Text("Review photos") }
                if (s.source != CaptureSource.IMPORT) TextButton(onClick = onCapture) { Text("Continue capture") }
                else TextButton(onClick = onImport) { Text("Add photos") }
            }
        }
    }
}

@Composable
fun JobRow(j: ReconJob, onClick: () -> Unit) {
    Card(onClick = onClick, colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow)) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusPill(phaseShort(j.phase), phaseTone(j.phase))
                Text("${j.preset.replaceFirstChar { it.uppercase() }} · ${photos(j.frameIds.size)} · ${formatDate(j.createdAtMs)}",
                     style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1,
                     overflow = TextOverflow.Ellipsis)
            }
            Text(jobStatusText(j), style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (j.phase.isActive) {
                val p = when (j.phase) {
                    dev.pocket3d.core.project.JobPhase.UPLOADING -> if (j.totalBytes > 0) j.uploadedBytes.toFloat() / j.totalBytes else 0f
                    dev.pocket3d.core.project.JobPhase.RUNNING -> j.overallProgress
                    else -> -1f
                }
                if (p >= 0f) LinearProgressIndicator(progress = { p.coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                else LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        }
    }
}

@Composable
private fun ModelCard(projectId: String, m: ModelVersion, active: Boolean, onOpen: () -> Unit, onAr: () -> Unit,
                      onSetActive: () -> Unit, onDelete: () -> Unit) {
    val thumbPath = remember(m.id) { File(Services.store.modelDir(projectId, m.id), "thumbnail.png").path }
    val thumb = rememberFileBitmap(thumbPath, 256)
    Card(onClick = onOpen, colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(72.dp).clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.surfaceContainerHighest),
                contentAlignment = Alignment.Center) {
                if (thumb != null) Image(thumb, "Rendering of this model", contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                else Text("Open to\nrender", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("${m.preset.replaceFirstChar { it.uppercase() }} · ${formatDate(m.createdAtMs)}", style = MaterialTheme.typography.titleSmall,
                         maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    if (active) StatusPill("Active", Tone.Good)
                }
                Text("${"%,d".format(m.faceCount)} triangles · ${m.registeredCameras}/${m.inputFrames} photos registered · ${formatBytes(m.glbBytes)}",
                     style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                StatusPill(if (m.reconstructionScale.isMetric) "AR-estimated scale" else "Arbitrary units until calibrated",
                           if (m.reconstructionScale.isMetric) Tone.Provisional else Tone.Warn)
                Row {
                    TextButton(onClick = onAr, contentPadding = PaddingValues(horizontal = 8.dp)) {
                        Icon(Icons.Outlined.ViewInAr, null, Modifier.size(18.dp)); Spacer(Modifier.width(4.dp)); Text("AR")
                    }
                    if (!active) TextButton(onClick = onSetActive, contentPadding = PaddingValues(horizontal = 8.dp)) { Text("Make active") }
                    IconButton(onClick = onDelete) { Icon(Icons.Outlined.Delete, "Delete this model") }
                }
            }
        }
    }
}
