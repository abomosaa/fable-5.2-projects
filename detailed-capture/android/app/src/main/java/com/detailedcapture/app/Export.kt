package com.detailedcapture.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File

data class ExportDone(val file: File, val mime: String, val summary: String)

object Exports {
    /** last finished export per project dir (shown in the export sheet for Share / Save as) */
    val last = kotlinx.coroutines.flow.MutableStateFlow<ExportDone?>(null)

    private fun safeName(s: String) = s.replace(Regex("[^A-Za-z0-9._-]+"), "_").trim('_').ifEmpty { "capture" }

    fun flat(project: Project, format: String, scale: Double = 1.0, quality: Int = 95) {
        val ext = when (format) { "jpeg" -> "jpg"; "tiff" -> "tif"; else -> "png" }
        val out = File(Repo.exportsDir, "${safeName(project.name)}-${System.currentTimeMillis().toString(36)}.$ext")
        JobManager.enqueue(Job("export", project.dir, "Exporting ${format.uppercase()}") { job ->
            val r = Core.call("export.flat", JSONObject().put("dir", project.dir.absolutePath).put("format", format).put("path", out.absolutePath)
                .put("scale", scale).put("quality", quality), job.token)
            val mime = when (format) { "jpeg" -> "image/jpeg"; "tiff" -> "image/tiff"; else -> "image/png" }
            val s = "${r.optInt("width")} × ${r.optInt("height")} px · ${fmtBytes(r.optLong("bytes"))} · 8-bit ${r.optString("colorSpace")}"
            last.value = ExportDone(out, mime, s)
            "Exported $s"
        })
    }

    fun tilePackage(project: Project, format: String) {
        val base = "${safeName(project.name)}-tiles-${System.currentTimeMillis().toString(36)}"
        val dir = File(Repo.exportsDir, base)
        val zip = File(Repo.exportsDir, "$base.zip")
        JobManager.enqueue(Job("export", project.dir, "Exporting tile package") { job ->
            try {
                val r = Core.call("export.tiles", JSONObject().put("dir", project.dir.absolutePath).put("outDir", dir.absolutePath).put("format", format), job.token)
                Repo.zipDir(dir, zip, { p -> job.manualProgress = Core.Progress("Packaging tiles", p, "") }, { job.cancelled })
                val s = "${r.optInt("width")} × ${r.optInt("height")} px pyramid · ${r.optInt("files")} files · ${fmtBytes(zip.length())}"
                last.value = ExportDone(zip, "application/zip", s)
                "Tile package ready ($s)"
            } finally {
                dir.deleteRecursively()
            }
        })
    }

    fun archive(project: Project, includeResult: Boolean) {
        val out = File(Repo.exportsDir, "${safeName(project.name)}-${System.currentTimeMillis().toString(36)}.dcap.zip")
        JobManager.enqueue(Job("export", project.dir, "Writing project archive") { job ->
            Repo.writeArchive(project, out, includeResult, { p -> job.manualProgress = Core.Progress("Writing project archive", p, "") }, { job.cancelled })
            last.value = ExportDone(out, "application/zip", "Project archive · ${fmtBytes(out.length())} · originals + transforms" + if (includeResult) " + result" else "")
            "Project archive ready (${fmtBytes(out.length())})"
        })
    }

    fun share(context: Context, e: ExportDone) {
        val uri = FileProvider.getUriForFile(context, "com.detailedcapture.app.files", e.file)
        val send = Intent(Intent.ACTION_SEND).setType(e.mime).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        send.clipData = android.content.ClipData.newRawUri(e.file.name, uri)
        context.startActivity(Intent.createChooser(send, "Share ${e.file.name}").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    fun copyTo(context: Context, e: ExportDone, dest: Uri) {
        context.contentResolver.openOutputStream(dest)?.use { out -> e.file.inputStream().use { it.copyTo(out, 1 shl 16) } }
            ?: throw UserFacingException("Could not write to the chosen location.")
    }
}
