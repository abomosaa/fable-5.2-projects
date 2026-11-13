package dev.pocket3d.app.ui

import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.ViewInAr
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pocket3d.core.project.DeletionPlan
import dev.pocket3d.core.project.JobPhase
import dev.pocket3d.core.project.ProjectSummary
import dev.pocket3d.core.services.Services
import dev.pocket3d.design.P3
import dev.pocket3d.design.StatusPill
import dev.pocket3d.design.Tone
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.cos
import kotlin.math.sin

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LibraryScreen(onOpenProject: (String) -> Unit, onNewProject: (String) -> Unit, onOpenPairing: () -> Unit,
                  onOpenSettings: () -> Unit) {
    val summaries by Services.store.summaries.collectAsStateWithLifecycle()
    val companion by Services.companion.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var showNew by rememberSaveable { mutableStateOf(false) }
    var renameTarget by remember { mutableStateOf<ProjectSummary?>(null) }
    var deleteTarget by remember { mutableStateOf<ProjectSummary?>(null) }
    var exportTarget by remember { mutableStateOf<ProjectSummary?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    var freeBytes by remember { mutableStateOf<Long?>(null) }
    LaunchedEffect(summaries) { freeBytes = Services.store.freeBytes() }
    LaunchedEffect(Unit) { Services.companion.refresh() }

    val exportLauncher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/zip")) { uri ->
        val target = exportTarget
        exportTarget = null
        if (uri != null && target != null) scope.launch {
            busy = "Exporting ${target.project.name}…"
            val result = runCatching {
                withContext(Dispatchers.IO) {
                    context.contentResolver.openOutputStream(uri)?.use { out ->
                        Services.store.exportProjectArchive(target.project.id, out)
                    } ?: error("Could not open the destination")
                }
            }
            busy = null
            toast(context, result.fold({ "Project exported" }, { "Export failed: ${it.message}" }))
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Pocket 3D Scanner") },
                actions = {
                    val (text, tone) = companionSummary(companion)
                    IconButton(onClick = onOpenPairing, modifier = Modifier.semantics { contentDescription = "$text. Open companion settings" }) {
                        Icon(Icons.Outlined.Computer, null, tint = when (tone) {
                            Tone.Good -> P3.colors.good; Tone.Warn -> P3.colors.warn; else -> MaterialTheme.colorScheme.onSurfaceVariant
                        })
                    }
                    IconButton(onClick = onOpenSettings) { Icon(Icons.Outlined.Settings, "Settings and device capabilities") }
                },
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(onClick = { showNew = true }, icon = { Icon(Icons.Outlined.Add, null) },
                                         text = { Text("New scan") })
        },
    ) { pad ->
        if (summaries.isEmpty()) {
            EmptyLibrary(Modifier.padding(pad).fillMaxSize(), onNew = { showNew = true }, companionPaired = companion.paired,
                         onPair = onOpenPairing)
        } else {
            LazyColumn(Modifier.padding(pad).fillMaxSize(), contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 96.dp),
                       verticalArrangement = Arrangement.spacedBy(12.dp)) {
                item {
                    val total = summaries.sumOf { it.diskBytes }
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        val (text, tone) = companionSummary(companion)
                        StatusPill(text, tone, Modifier.clickable(onClick = onOpenPairing))
                        Text("${summaries.size} project${if (summaries.size == 1) "" else "s"} · ${formatBytes(total)} used" +
                                 (freeBytes?.let { " · ${formatBytes(it)} free on this phone" } ?: ""),
                             style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (busy != null) {
                        Spacer(Modifier.height(8.dp))
                        Text(busy!!, style = MaterialTheme.typography.bodySmall)
                        LinearProgressIndicator(Modifier.fillMaxWidth())
                    }
                }
                items(summaries, key = { it.project.id }) { s ->
                    ProjectCard(s, onOpen = { onOpenProject(s.project.id) }, onRename = { renameTarget = s },
                                onDuplicate = {
                                    scope.launch {
                                        busy = "Duplicating ${s.project.name}…"
                                        val r = runCatching { Services.store.duplicateProject(s.project.id) }
                                        busy = null
                                        r.exceptionOrNull()?.let { toast(context, "Could not duplicate: ${it.message}") }
                                    }
                                },
                                onExport = { exportTarget = s; exportLauncher.launch(safeFileName(s.project.name) + ".pocket3d.zip") },
                                onDelete = { deleteTarget = s })
                }
            }
        }
    }

    if (showNew) {
        NameDialog(title = "New scan", initial = "", confirm = "Create", onDismiss = { showNew = false }) { name ->
            showNew = false
            scope.launch {
                val p = Services.store.createProject(name.ifBlank { "Scan ${summaries.size + 1}" })
                // navigation must happen on the main thread whatever dispatcher resumed us
                withContext(Dispatchers.Main.immediate) { onNewProject(p.id) }
            }
        }
    }
    renameTarget?.let { t ->
        NameDialog(title = "Rename project", initial = t.project.name, confirm = "Rename", onDismiss = { renameTarget = null }) { name ->
            renameTarget = null
            if (name.isNotBlank()) scope.launch { Services.store.renameProject(t.project.id, name.trim()) }
        }
    }
    deleteTarget?.let { t -> DeleteProjectDialog(t, onDismiss = { deleteTarget = null }) }
}

private fun safeFileName(name: String) = name.map { if (it.isLetterOrDigit() || it == '-' || it == '_') it else '_' }.joinToString("").take(60).ifBlank { "project" }

@Composable
private fun ProjectCard(s: ProjectSummary, onOpen: () -> Unit, onRename: () -> Unit, onDuplicate: () -> Unit,
                        onExport: () -> Unit, onDelete: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Card(onClick = onOpen, colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
         modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            val thumb = rememberFileBitmap(s.thumbnailPath, 256, s.project.updatedAtMs)
            Box(Modifier.size(84.dp).clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceContainerHighest),
                contentAlignment = Alignment.Center) {
                if (thumb != null) {
                    Image(thumb, "Rendering of the reconstructed model", contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                } else {
                    // No picture is shown until a real model exists.
                    Text(if (s.hasModel) "Open model\nto render" else "No model\nyet", style = MaterialTheme.typography.labelSmall, textAlign = TextAlign.Center,
                         color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(s.project.name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(2.dp))
                Text("${s.frameCount} photo${if (s.frameCount == 1) "" else "s"} · ${formatBytes(s.diskBytes)} · ${formatDate(s.project.updatedAtMs)}",
                     style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1,
                     overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(8.dp))
                val phase = s.latestJobPhase
                when {
                    phase != null && phase.isActive -> {
                        StatusPill(phaseShort(phase) + if (phase == JobPhase.RUNNING) " ${(s.latestJobProgress * 100).toInt()}%" else "", Tone.Companion)
                        Spacer(Modifier.height(6.dp))
                        LinearProgressIndicator(progress = { s.latestJobProgress.coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                    }
                    phase != null && phase != JobPhase.COMPLETED ->
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            StatusPill(phaseShort(phase), phaseTone(phase))
                            if (s.hasModel) StatusPill("Earlier model kept", Tone.Good)
                        }
                    s.hasModel -> StatusPill("Model ready", Tone.Good)
                    s.frameCount > 0 -> StatusPill("Not reconstructed yet", Tone.Neutral)
                    else -> StatusPill("No photos yet", Tone.Neutral)
                }
            }
            Box {
                IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, "Project actions for ${s.project.name}") }
                DropdownMenu(menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text("Rename") }, onClick = { menu = false; onRename() })
                    DropdownMenuItem(text = { Text("Duplicate") }, onClick = { menu = false; onDuplicate() })
                    DropdownMenuItem(text = { Text("Export project (.zip)") }, onClick = { menu = false; onExport() })
                    DropdownMenuItem(text = { Text("Delete…") }, onClick = { menu = false; onDelete() })
                }
            }
        }
    }
}

@Composable
private fun EmptyLibrary(modifier: Modifier, onNew: () -> Unit, companionPaired: Boolean, onPair: () -> Unit) {
    Column(modifier.padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        val ring = MaterialTheme.colorScheme.primary
        val dim = MaterialTheme.colorScheme.outlineVariant
        Canvas(Modifier.size(160.dp)) {
            val c = Offset(size.width / 2, size.height / 2)
            val r = size.minDimension * 0.42f
            drawCircle(dim, r, c, style = Stroke(2.dp.toPx()))
            for (i in 0 until 12) {
                val a = Math.toRadians(i * 30.0 - 90)
                drawCircle(ring.copy(alpha = 1f - i / 14f), 5.dp.toPx(), Offset(c.x + r * cos(a).toFloat(), c.y + r * sin(a).toFloat()))
            }
            drawRoundRect(ring, topLeft = Offset(c.x - r * 0.28f, c.y - r * 0.36f),
                          size = androidx.compose.ui.geometry.Size(r * 0.56f, r * 0.72f),
                          cornerRadius = androidx.compose.ui.geometry.CornerRadius(10.dp.toPx()))
        }
        Spacer(Modifier.height(24.dp))
        Text("Scan a real object", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(8.dp))
        Text("Walk around a stationary object taking overlapping photos. A companion computer on your network turns " +
                 "them into a textured 3D model you can inspect, clean, measure, export and place in AR.",
             style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        Spacer(Modifier.height(24.dp))
        Button(onClick = onNew) { Icon(Icons.Outlined.ViewInAr, null); Spacer(Modifier.width(8.dp)); Text("Start a new scan") }
        if (!companionPaired) {
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = onPair) { Icon(Icons.Outlined.Computer, null); Spacer(Modifier.width(8.dp)); Text("Pair a companion computer") }
        }
    }
}

@Composable
fun NameDialog(title: String, initial: String, confirm: String, onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    var text by rememberSaveable { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss, title = { Text(title) },
        text = { OutlinedTextField(text, { text = it.take(80) }, singleLine = true, label = { Text("Name") }, modifier = Modifier.fillMaxWidth()) },
        confirmButton = { TextButton(onClick = { onConfirm(text) }) { Text(confirm) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Spells out exactly what will be removed, including copies held by the companion. */
@Composable
private fun DeleteProjectDialog(target: ProjectSummary, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val companion by Services.companion.state.collectAsStateWithLifecycle()
    var plan by remember { mutableStateOf<DeletionPlan?>(null) }
    var remoteSessions by remember { mutableStateOf<List<String>>(emptyList()) }
    var otherCompanions by remember { mutableStateOf<List<String>>(emptyList()) }
    var activeJobs by remember { mutableStateOf(0) }
    var alsoRemote by remember { mutableStateOf(true) }
    var working by remember { mutableStateOf(false) }
    LaunchedEffect(target.project.id) {
        plan = Services.store.deletionPlan(target.project.id)
        val serverId = Services.companion.state.value.serverId
        val jobs = Services.store.jobs(target.project.id)
        activeJobs = jobs.count { it.phase.isActive }
        remoteSessions = jobs.filter { it.companionId != null && it.companionId == serverId }.map { it.sessionId }.distinct()
        // photos that were uploaded to a companion this phone is no longer paired with cannot be removed from here
        otherCompanions = jobs.filter { it.companionId != null && it.companionId != serverId }
            .map { it.companionName ?: "another companion" }.distinct()
        Services.companion.refresh()
    }
    val reachable = companion.paired && companion.reachable == true
    AlertDialog(
        onDismissRequest = { if (!working) onDismiss() },
        title = { Text("Delete “${target.project.name}”?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                val p = plan
                if (p == null) Text("Checking what will be removed…") else {
                    if (activeJobs > 0) {
                        Text("A reconstruction for this project is still in progress and will be cancelled.",
                             style = MaterialTheme.typography.bodyMedium, color = P3.colors.warn)
                    }
                    Text("This permanently removes from this phone:", style = MaterialTheme.typography.bodyMedium)
                    Text("• ${p.photoCount} source photo${if (p.photoCount == 1) "" else "s"} (${formatBytes(p.photoBytes)})\n" +
                             "• ${p.modelCount} reconstructed model${if (p.modelCount == 1) "" else "s"} with edits and measurements (${formatBytes(p.modelBytes)})\n" +
                             "• ${formatBytes(p.totalBytes)} in total",
                         style = MaterialTheme.typography.bodyMedium)
                    if (remoteSessions.isEmpty()) {
                        Text("No copies of these photos are known to be on a paired companion.", style = MaterialTheme.typography.bodySmall,
                             color = MaterialTheme.colorScheme.onSurfaceVariant)
                    } else if (reachable) {
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable { alsoRemote = !alsoRemote }) {
                            Checkbox(alsoRemote, { alsoRemote = it })
                            Text("Also delete the uploaded copies and job data on companion “${companion.serverName}” " +
                                     "(${remoteSessions.size} capture set${if (remoteSessions.size == 1) "" else "s"})",
                                 style = MaterialTheme.typography.bodyMedium)
                        }
                    } else {
                        Text("Companion “${companion.serverName ?: "?"}” holds uploaded copies of ${remoteSessions.size} capture " +
                                 "set${if (remoteSessions.size == 1) "" else "s"} but is not reachable now. Those copies will REMAIN on " +
                                 "the companion; remove them later with “pocket3d-companion devices revoke --purge” or by deleting its data folder.",
                             style = MaterialTheme.typography.bodySmall, color = P3.colors.warn)
                    }
                }
                if (otherCompanions.isNotEmpty()) {
                    Text("Photos of this project were also uploaded to ${otherCompanions.joinToString()} — a companion this phone " +
                             "is no longer paired with. Those copies cannot be removed from here; delete them on that computer.",
                         style = MaterialTheme.typography.bodySmall, color = P3.colors.warn)
                }
                if (working) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            TextButton(enabled = plan != null && !working, onClick = {
                working = true
                scope.launch {
                    var note = "Project deleted"
                    if (remoteSessions.isNotEmpty() && reachable && alsoRemote) {
                        val removed = runCatching { Services.companion.deleteRemoteSessions(remoteSessions) }.getOrDefault(emptyList())
                        note = if (removed.size == remoteSessions.size) "Project and companion copies deleted"
                        else "Project deleted; ${remoteSessions.size - removed.size} companion copy(ies) could not be removed"
                    }
                    // a reconstruction still running for this project is cancelled first (also on the companion)
                    runCatching {
                        Services.store.jobs(target.project.id).filter { it.phase.isActive }
                            .forEach { Services.reconstruction.cancelJob(target.project.id, it.id) }
                    }
                    runCatching { Services.store.deleteProject(target.project.id) }
                        .onFailure { note = "Delete failed: ${it.message}" }
                    toast(context, note)
                    onDismiss()
                }
            }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(enabled = !working, onClick = onDismiss) { Text("Cancel") } },
    )
}
