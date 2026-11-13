package dev.pocket3d.app.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.runtime.Composable
import androidx.compose.runtime.produceState
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import dev.pocket3d.core.project.JobPhase
import dev.pocket3d.core.project.ReconJob
import dev.pocket3d.core.services.CompanionState
import dev.pocket3d.design.Tone
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.text.DateFormat
import java.util.Date

/** "1 photo", "12 photos". */
fun photos(n: Int): String = if (n == 1) "1 photo" else "$n photos"

fun formatBytes(bytes: Long): String = when {
    bytes >= 1L shl 30 -> "%.1f GB".format(bytes / (1L shl 30).toDouble())
    bytes >= 1L shl 20 -> "%.0f MB".format(bytes / (1L shl 20).toDouble())
    bytes >= 1L shl 10 -> "%.0f KB".format(bytes / (1L shl 10).toDouble())
    else -> "$bytes B"
}

fun formatDate(ms: Long): String = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(ms))

fun formatDuration(seconds: Double): String {
    val s = seconds.toLong()
    return if (s >= 60) "${s / 60} min ${s % 60} s" else "$s s"
}

/** Human names of the companion pipeline stages (ids from docs/companion-protocol.md §4). */
val STAGE_LABELS: List<Pair<String, String>> = listOf(
    "ingest" to "Checking photos",
    "features" to "Finding image features",
    "matching" to "Matching photos",
    "sfm" to "Solving camera positions",
    "undistort" to "Removing lens distortion",
    "dense" to "Dense depth maps",
    "mesh" to "Building surface",
    "refine" to "Refining surface",
    "texture" to "Texturing",
    "package" to "Packaging model",
)

fun stageLabel(id: String?): String = STAGE_LABELS.firstOrNull { it.first == id }?.second ?: (id ?: "")

/** One-line, honest status of a job for lists. */
fun jobStatusText(job: ReconJob): String = when (job.phase) {
    JobPhase.PENDING -> job.waitingReason ?: "Waiting to start"
    JobPhase.UPLOADING -> job.waitingReason ?: "Uploading photos to companion ${percent(job.uploadedBytes, job.totalBytes)}"
    JobPhase.QUEUED -> job.waitingReason ?: if (job.queuePosition > 0) "Queued on companion (position ${job.queuePosition})" else "Queued on companion"
    JobPhase.RUNNING -> job.waitingReason ?: "Companion: ${stageLabel(job.stage).lowercase()} · ${(job.overallProgress * 100).toInt()}%"
    JobPhase.DOWNLOADING -> job.waitingReason ?: "Downloading and verifying result"
    JobPhase.COMPLETED -> "Model ready"
    JobPhase.FAILED -> "Failed" + (job.error?.message?.let { " — $it" } ?: "")
    JobPhase.CANCELLED -> "Cancelled"
    JobPhase.INTERRUPTED -> "Interrupted — companion stopped before finishing"
}

fun phaseTone(phase: JobPhase): Tone = when (phase) {
    JobPhase.COMPLETED -> Tone.Good
    JobPhase.FAILED -> Tone.Bad
    JobPhase.CANCELLED, JobPhase.INTERRUPTED -> Tone.Warn
    else -> Tone.Companion
}

fun phaseShort(phase: JobPhase): String = when (phase) {
    JobPhase.PENDING -> "Pending"
    JobPhase.UPLOADING -> "Uploading"
    JobPhase.QUEUED -> "Queued"
    JobPhase.RUNNING -> "Reconstructing"
    JobPhase.DOWNLOADING -> "Downloading"
    JobPhase.COMPLETED -> "Model ready"
    JobPhase.FAILED -> "Failed"
    JobPhase.CANCELLED -> "Cancelled"
    JobPhase.INTERRUPTED -> "Interrupted"
}

private fun percent(a: Long, b: Long): String = if (b > 0) "${(100 * a / b).coerceIn(0, 100)}%" else ""

fun companionSummary(s: CompanionState): Pair<String, Tone> = when {
    !s.paired -> "No companion paired" to Tone.Warn
    s.checking && s.reachable == null -> "Checking ${s.serverName ?: "companion"}…" to Tone.Neutral
    s.reachable == true -> "Companion ${s.serverName ?: ""} connected".trim() to Tone.Good
    s.reachable == false -> "Companion ${s.serverName ?: ""} unreachable".trim() to Tone.Warn
    else -> "Companion ${s.serverName ?: ""}".trim() to Tone.Neutral
}

/** Decodes a (small) image file off the main thread; null while loading or if missing/corrupt. */
@Composable
fun rememberFileBitmap(path: String?, maxSide: Int = 512, version: Long = 0): ImageBitmap? =
    produceState<ImageBitmap?>(initialValue = null, path, version) {
        value = if (path == null) null else withContext(Dispatchers.IO) { decodeSampled(File(path), maxSide)?.asImageBitmap() }
    }.value

fun decodeSampled(file: File, maxSide: Int): Bitmap? {
    if (!file.isFile) return null
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
    return BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
}


/** Toast from any thread (coroutines may resume off the main thread; Toast needs a Looper). */
fun toast(context: android.content.Context, text: String) {
    val app = context.applicationContext
    android.os.Handler(android.os.Looper.getMainLooper()).post {
        android.widget.Toast.makeText(app, text, android.widget.Toast.LENGTH_LONG).show()
    }
}
