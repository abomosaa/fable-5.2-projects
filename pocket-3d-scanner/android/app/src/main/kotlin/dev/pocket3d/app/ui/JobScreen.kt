package dev.pocket3d.app.ui

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pocket3d.core.project.JobPhase
import dev.pocket3d.core.project.ReconJob
import dev.pocket3d.core.services.Services
import dev.pocket3d.design.InfoBanner
import dev.pocket3d.design.LabeledValue
import dev.pocket3d.design.P3
import dev.pocket3d.design.SectionTitle
import dev.pocket3d.design.StatusPill
import dev.pocket3d.design.Tone
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// --- tiny helpers to read the companion's diagnostics object defensively ---------------------
private fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject
private fun JsonObject.arr(key: String): JsonArray? = this[key] as? JsonArray
private fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.intOrNull
private fun JsonObject.dbl(key: String): Double? = (this[key] as? JsonPrimitive)?.doubleOrNull
private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
private fun JsonElement.asObj(): JsonObject? = this as? JsonObject

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun JobScreen(projectId: String, jobId: String, onBack: () -> Unit, onOpenSparsePreview: () -> Unit,
              onOpenModel: (modelId: String) -> Unit, onReviewPhotos: (sessionId: String) -> Unit) {
    val job by remember(projectId, jobId) { Services.store.observeJob(projectId, jobId) }.collectAsStateWithLifecycle(initialValue = null)
    val scope = rememberCoroutineScope()
    var confirmCancel by remember { mutableStateOf(false) }
    // photo display names for the diagnostics (the companion only knows the phone's frame ids)
    val frameNames by produceState(emptyMap<String, String>(), job?.sessionId) {
        val sid = job?.sessionId
        if (sid != null) value = Services.store.session(projectId, sid)?.frames?.associate { it.id to it.name } ?: emptyMap()
    }
    Scaffold(topBar = {
        TopAppBar(title = { Text("Reconstruction") },
                  navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") } })
    }) { pad ->
        val j = job
        if (j == null) {
            Box(Modifier.padding(pad).fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            return@Scaffold
        }
        LazyColumn(Modifier.padding(pad).fillMaxSize(), contentPadding = PaddingValues(16.dp, 0.dp, 16.dp, 32.dp)) {
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    StatusPill(phaseShort(j.phase), phaseTone(j.phase))
                    StatusPill("On companion" + (j.companionName?.let { " “$it”" } ?: ""), Tone.Companion)
                }
                Spacer(Modifier.height(4.dp))
                Text("${j.preset.replaceFirstChar { it.uppercase() }} quality · ${photos(j.frameIds.size)} · started ${formatDate(j.createdAtMs)}" +
                         if (j.attempt > 1) " · attempt ${j.attempt}" else "",
                     style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(12.dp))
            }
            j.waitingReason?.let { reason ->
                if (j.phase.isActive) item { InfoBanner(reason, tone = Tone.Warn,
                                                         body = "Nothing is lost. When the companion is reachable again the job continues — or, if the companion " +
                                                             "was restarted meanwhile, it is shown as interrupted and can be retried."); Spacer(Modifier.height(12.dp)) }
            }
            item { PhaseCard(j, onOpenModel, onRetry = { scope.launch { Services.reconstruction.retryJob(projectId, jobId) } },
                             onReviewPhotos = { onReviewPhotos(j.sessionId) }) }
            if (j.phase == JobPhase.RUNNING || j.phase == JobPhase.DOWNLOADING || j.phase == JobPhase.COMPLETED || j.stageCount > 0) {
                item { SectionTitle("Stages", trailing = { StatusPill("Progress reported by the companion", Tone.Companion) }) }
                item { StageList(j) }
            }
            if (j.hasSparsePreview) item {
                Spacer(Modifier.height(12.dp))
                OutlinedButton(onClick = onOpenSparsePreview, modifier = Modifier.fillMaxWidth()) { Text("View provisional sparse preview") }
                Text("Tie points and camera positions from the companion. Provisional — not the final surface.",
                     style = MaterialTheme.typography.bodySmall, color = P3.colors.provisional)
            }
            item { Diagnostics(j, frameNames) }
            if (j.phase.canCancel) item {
                Spacer(Modifier.height(20.dp))
                OutlinedButton(onClick = { confirmCancel = true }, modifier = Modifier.fillMaxWidth()) { Text("Cancel reconstruction") }
            }
            if (j.phase.isTerminal && j.phase != JobPhase.COMPLETED) item {
                Spacer(Modifier.height(8.dp))
                TextButton(onClick = { scope.launch { Services.reconstruction.deleteJob(projectId, jobId); withContext(Dispatchers.Main.immediate) { onBack() } } }) { Text("Remove this job record") }
            }
        }
    }
    if (confirmCancel) {
        AlertDialog(onDismissRequest = { confirmCancel = false }, title = { Text("Cancel this reconstruction?") },
                    text = { Text("The companion stops working on it. Your photos and any earlier model are kept; you can retry later.") },
                    confirmButton = { TextButton(onClick = { confirmCancel = false; scope.launch { Services.reconstruction.cancelJob(projectId, jobId) } }) { Text("Cancel job") } },
                    dismissButton = { TextButton(onClick = { confirmCancel = false }) { Text("Keep running") } })
    }
}

@Composable
private fun PhaseCard(j: ReconJob, onOpenModel: (String) -> Unit, onRetry: () -> Unit, onReviewPhotos: () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            when (j.phase) {
                JobPhase.PENDING -> { Text("Preparing upload", style = MaterialTheme.typography.titleMedium); LinearProgressIndicator(Modifier.fillMaxWidth()) }
                JobPhase.UPLOADING -> {
                    Text("Uploading photos to the companion", style = MaterialTheme.typography.titleMedium)
                    val p = if (j.totalBytes > 0) j.uploadedBytes.toFloat() / j.totalBytes else 0f
                    LinearProgressIndicator(progress = { p.coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                    Text("${formatBytes(j.uploadedBytes)} of ${formatBytes(j.totalBytes)} · original files, encrypted, resumable",
                         style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                JobPhase.QUEUED -> {
                    Text("Waiting for the companion", style = MaterialTheme.typography.titleMedium)
                    Text(if (j.queuePosition > 0) "Position ${j.queuePosition} in its queue." else "It will start shortly.",
                         style = MaterialTheme.typography.bodyMedium)
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                }
                JobPhase.RUNNING -> {
                    Text(stageLabel(j.stage), style = MaterialTheme.typography.titleMedium)
                    if (j.message.isNotBlank()) Text(j.message, style = MaterialTheme.typography.bodyMedium)
                    LinearProgressIndicator(progress = { j.overallProgress.coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                    Text("Overall ${(j.overallProgress * 100).toInt()}% · the reconstruction runs on the companion computer, not on this phone. " +
                             "You can leave this screen or the app.", style = MaterialTheme.typography.bodySmall,
                         color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                JobPhase.DOWNLOADING -> {
                    Text("Downloading and verifying the result", style = MaterialTheme.typography.titleMedium)
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                    Text("The model becomes available only after every file's checksum matches.", style = MaterialTheme.typography.bodySmall,
                         color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                JobPhase.COMPLETED -> {
                    Text("Model ready", style = MaterialTheme.typography.titleMedium)
                    Text("Downloaded and verified. Check the diagnostics below for weak areas before relying on it.", style = MaterialTheme.typography.bodyMedium)
                    j.modelId?.let { mid -> Button(onClick = { onOpenModel(mid) }, modifier = Modifier.fillMaxWidth()) { Text("Open model") } }
                }
                JobPhase.FAILED -> {
                    Text("Reconstruction failed", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.error)
                    Text(j.error?.message ?: "No details were reported.", style = MaterialTheme.typography.bodyMedium)
                    val guidance = j.error?.guidance.orEmpty()
                    if (guidance.isNotEmpty()) {
                        Text("What to try", style = MaterialTheme.typography.labelLarge)
                        guidance.forEach { Text("• $it", style = MaterialTheme.typography.bodyMedium) }
                    }
                    j.error?.code?.takeIf { it.isNotBlank() }?.let { Text("Code: $it", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = onRetry) { Text("Retry") }
                        OutlinedButton(onClick = onReviewPhotos) { Text("Review photos") }
                    }
                    Text("No model was created from this attempt.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                JobPhase.CANCELLED -> {
                    Text("Cancelled", style = MaterialTheme.typography.titleMedium)
                    Text("You cancelled this reconstruction. No model was created from it.", style = MaterialTheme.typography.bodyMedium)
                    Button(onClick = onRetry) { Text("Start again") }
                }
                JobPhase.INTERRUPTED -> {
                    Text("Interrupted", style = MaterialTheme.typography.titleMedium, color = P3.colors.warn)
                    Text(j.error?.message ?: "The companion stopped or restarted before the reconstruction finished. Nothing was completed; " +
                        "finished stages are reused when you retry.", style = MaterialTheme.typography.bodyMedium)
                    Button(onClick = onRetry) { Text("Retry") }
                }
            }
        }
    }
}

@Composable
private fun StageList(j: ReconJob) {
    val refineEnabled = j.stageCount >= STAGE_LABELS.size || j.stage == "refine" || j.preset == "high"
    val stages = STAGE_LABELS.filter { it.first != "refine" || refineEnabled }
    val currentIndex = stages.indexOfFirst { it.first == j.stage }
    val allDone = j.phase == JobPhase.COMPLETED || j.phase == JobPhase.DOWNLOADING
    Column {
        stages.forEachIndexed { i, (id, label) ->
            val done = allDone || (currentIndex >= 0 && i < currentIndex)
            val current = !allDone && i == currentIndex && j.phase == JobPhase.RUNNING
            Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                when {
                    done -> Icon(Icons.Outlined.CheckCircle, "done", tint = P3.colors.good, modifier = Modifier.size(20.dp))
                    current -> CircularProgressIndicator(progress = { j.stageProgress.coerceIn(0f, 1f) }, modifier = Modifier.size(20.dp), strokeWidth = 3.dp)
                    else -> Icon(Icons.Outlined.RadioButtonUnchecked, "not started", tint = MaterialTheme.colorScheme.outline, modifier = Modifier.size(20.dp))
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(label, style = MaterialTheme.typography.bodyMedium,
                         color = if (done || current) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
                    if (current && j.message.isNotBlank()) Text(j.message, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (current) Text("${(j.stageProgress * 100).toInt()}%", style = MaterialTheme.typography.labelMedium)
                val seconds = j.diagnostics.obj("timings_s")?.dbl(id)
                if (done && seconds != null) Text(formatDuration(seconds), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun Diagnostics(j: ReconJob, frameNames: Map<String, String>) {
    fun name(id: String?): String = id?.let { frameNames[it] ?: it } ?: "?"
    val d = j.diagnostics
    if (d.isEmpty()) return
    SectionTitle("Diagnostics")
    val input = d.obj("input")
    val sfm = d.obj("sfm")
    Column {
        input?.let { inp ->
            val frames = inp.int("frames"); val usable = inp.int("usable")
            if (frames != null && usable != null) LabeledValue("Photos readable", "$usable / $frames", tone = if (usable < frames) Tone.Warn else Tone.Neutral)
            inp.arr("rejected")?.takeIf { it.isNotEmpty() }?.let { rej ->
                Text("Rejected: " + rej.mapNotNull { it.asObj()?.let { o -> "${name(o.str("id"))} (${o.str("reason")})" } }.joinToString(", "),
                     style = MaterialTheme.typography.bodySmall, color = P3.colors.warn)
            }
        }
        d.obj("features")?.int("median_per_image")?.let { LabeledValue("Features per photo (median)", "%,d".format(it), tone = if (it < 1200) Tone.Warn else Tone.Neutral) }
        sfm?.let { s ->
            val reg = s.int("registered"); val n = s.int("input_frames")
            if (reg != null && n != null) LabeledValue("Cameras registered", "$reg / $n", tone = when { reg == n -> Tone.Good; reg >= n * 0.8 -> Tone.Warn; else -> Tone.Bad })
            s.arr("unregistered")?.takeIf { it.isNotEmpty() }?.let { un ->
                Text("Not registered (${un.size}): " + un.take(12).mapNotNull { it.asObj()?.str("id")?.let(::name) }.joinToString(", ") + if (un.size > 12) " …" else "",
                     style = MaterialTheme.typography.bodySmall, color = P3.colors.warn)
                Text("These photos do not contribute to the model. Open the model’s camera view to see where coverage is missing.",
                     style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            s.int("sparse_points")?.let { LabeledValue("Sparse tie points", "%,d".format(it)) }
            s.dbl("mean_reprojection_error_px")?.let {
                LabeledValue("Reprojection error", "%.2f px".format(it))
                Text("Internal consistency of the camera solution — not a measure of geometric accuracy.",
                     style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        d.obj("viewpoint_coverage")?.let { c ->
            val az = c.int("azimuth_bins_covered"); val bins = c.int("azimuth_bins") ?: 12
            if (az != null) LabeledValue("Registered viewpoints", "$az / $bins sectors", tone = if (az >= bins - 1) Tone.Good else Tone.Warn)
            c.dbl("largest_azimuth_gap_deg")?.let { if (it > 45) LabeledValue("Largest gap between viewpoints", "${it.toInt()}°", tone = Tone.Warn) }
        }
        d.obj("dense")?.int("dense_points")?.let { LabeledValue("Dense surface points", "%,d".format(it)) }
        d.obj("mesh")?.let { m ->
            m.int("faces")?.let { LabeledValue("Triangles", "%,d".format(it)) }
            m.obj("object_region")?.let { o ->
                o.dbl("well_supported_area_fraction")?.let { LabeledValue("Surface well supported by photos", "${(it * 100).toInt()}%", tone = if (it > 0.85) Tone.Good else Tone.Warn) }
                val weak = (o.dbl("weak_area_fraction") ?: 0.0) + (o.dbl("unsupported_area_fraction") ?: 0.0)
                if (weak > 0.02) LabeledValue("Weak or unsupported surface", "${(weak * 100).toInt()}%", tone = Tone.Warn)
                o.obj("boundary")?.int("boundary_loops")?.let { LabeledValue("Open boundaries / holes", "$it") }
            }
        }
        d.obj("scale")?.let { sc ->
            val metric = sc.str("units") == "meters"
            val unc = sc.dbl("relative_uncertainty")
            LabeledValue("Scale", when {
                             !metric -> "Arbitrary units"
                             unc == null -> "AR-estimated (uncertainty not reported)"
                             // never round an uncertainty down
                             else -> "AR-estimated ±${"%.1f".format(java.util.Locale.ROOT, kotlin.math.ceil(unc * 1000) / 10)}%"
                         },
                         tone = if (metric) Tone.Provisional else Tone.Warn)
        }
        d.obj("timings_s")?.dbl("total")?.let { LabeledValue("Companion processing time", formatDuration(it)) }
        (d["peak_rss_mb"] as? JsonPrimitive)?.doubleOrNull?.let { LabeledValue("Companion peak memory", "%.1f GB".format(it / 1024.0)) }
        d.arr("warnings")?.takeIf { it.isNotEmpty() }?.let { ws ->
            Spacer(Modifier.height(8.dp))
            ws.forEach { w -> w.asObj()?.str("message")?.let { InfoBanner(it, tone = Tone.Warn); Spacer(Modifier.height(6.dp)) } }
        }
    }
}
