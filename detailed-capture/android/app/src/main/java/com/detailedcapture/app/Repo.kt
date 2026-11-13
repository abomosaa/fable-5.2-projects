package com.detailedcapture.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.net.Uri
import android.os.Build
import android.os.StatFs
import android.provider.OpenableColumns
import androidx.exifinterface.media.ExifInterface
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.util.UUID
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

class UserFacingException(message: String) : Exception(message)

/** Project storage: one folder per project in app-specific storage. Originals are stored byte-for-byte. */
object Repo {
    lateinit var appContext: Context

    val root: File
        get() = File(appContext.getExternalFilesDir(null) ?: appContext.filesDir, "projects").apply { mkdirs() }
    val exportsDir: File
        get() = File(appContext.getExternalFilesDir(null) ?: appContext.filesDir, "exports").apply { mkdirs() }

    fun freeBytes(): Long = try {
        val s = StatFs(root.absolutePath); s.availableBytes
    } catch (e: Exception) {
        Long.MAX_VALUE
    }

    fun requireSpace(needed: Long, what: String) {
        val free = freeBytes()
        if (free < needed + 48L * 1024 * 1024)
            throw UserFacingException("Not enough free storage to $what (needs about ${needed / 1_000_000 + 48} MB, ${free / 1_000_000} MB free). Free up space and try again; nothing was lost.")
    }

    fun list(): List<Project> = (root.listFiles() ?: emptyArray())
        .filter { File(it, "project.json").exists() }
        .mapNotNull { runCatching { load(it) }.getOrNull() }
        .sortedByDescending { it.j.optString("modifiedAt") }

    fun load(dir: File, recover: Boolean = false): Project =
        Project(dir, Core.call("project.load", JSONObject().put("dir", dir.absolutePath).put("recover", recover)))

    fun create(name: String): Project {
        requireSpace(32L * 1024 * 1024, "create a project")
        val dir = File(root, "p" + System.currentTimeMillis().toString(36) + UUID.randomUUID().toString().take(4))
        return Project(dir, Core.call("project.create", JSONObject().put("dir", dir.absolutePath).put("name", name)))
    }

    fun delete(dir: File) {
        Core.call("session.drop", JSONObject().put("dir", dir.absolutePath))
        dir.deleteRecursively()
    }

    private fun sniff(head: ByteArray, n: Int): String = when {
        n > 3 && head[0] == 0xFF.toByte() && head[1] == 0xD8.toByte() -> "jpg"
        n > 8 && head[0] == 0x89.toByte() && head[1] == 'P'.code.toByte() -> "png"
        n > 12 && String(head, 0, 4) == "RIFF" && String(head, 8, 4) == "WEBP" -> "webp"
        n > 12 && String(head, 4, 4) == "ftyp" -> "heic"
        n > 4 && ((head[0] == 'I'.code.toByte() && head[1] == 'I'.code.toByte()) || (head[0] == 'M'.code.toByte() && head[1] == 'M'.code.toByte())) -> "tif"  // TIFF container (also DNG and most RAW)
        else -> "bin"
    }

    private fun displayName(uri: Uri): String {
        runCatching {
            appContext.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) return c.getString(0) ?: ""
            }
        }
        return uri.lastPathSegment ?: ""
    }

    /**
     * Copies the bytes behind [uri] unchanged into the project and registers the frame with the core.
     * Formats the core cannot decode itself (HEIC, RAW/DNG, WebP, TIFF) additionally get a lossless PNG working copy
     * produced by the platform decoder; the original stays untouched next to it.
     */
    fun importImage(project: File, uri: Uri, role: String, hint: JSONObject? = null, source: String = "import"): JSONObject {
        val resolver = appContext.contentResolver
        val size = runCatching { resolver.openAssetFileDescriptor(uri, "r")?.use { it.length } }.getOrNull() ?: -1L
        requireSpace(if (size > 0) size * 3 else 64L * 1024 * 1024, "import this photo")
        val name = displayName(uri)
        val tmp = File(project, "originals/.incoming-" + UUID.randomUUID().toString().take(8))
        tmp.parentFile?.mkdirs()
        val head = ByteArray(16)
        var headN = 0
        try {
            (resolver.openInputStream(uri) ?: throw UserFacingException("Could not open that photo.")).use { ins ->
                FileOutputStream(tmp).use { out ->
                    val buf = ByteArray(1 shl 16)
                    var first = true
                    while (true) {
                        val n = ins.read(buf)
                        if (n <= 0) break
                        if (first) {
                            headN = minOf(n, 16); System.arraycopy(buf, 0, head, 0, headN); first = false
                        }
                        out.write(buf, 0, n)
                    }
                    out.fd.sync()
                }
            }
        } catch (e: java.io.IOException) {
            tmp.delete()
            throw UserFacingException("Could not copy the photo (${e.message ?: "I/O error"}). If storage is full, free up space and retry.")
        }
        val ext = sniff(head, headN).let { if (it == "tif" && name.lowercase().endsWith(".dng")) "dng" else it }
        return registerFile(project, tmp, ext, role, hint, source, name, JSONObject(), JSONArray())
    }

    /** Registers a file that is already inside the project folder (camera capture or import copy). */
    fun registerFile(project: File, incoming: File, ext: String, role: String, hint: JSONObject?, source: String, name: String, capture: JSONObject, sidecars: JSONArray): JSONObject {
        val base = (if (role == "overview") "overview-" else "img-") + System.currentTimeMillis().toString(36) + UUID.randomUUID().toString().take(4)
        val rel = "originals/$base.$ext"
        val dst = File(project, rel)
        if (!incoming.renameTo(dst)) {
            incoming.copyTo(dst, overwrite = true); incoming.delete()
        }
        val args = JSONObject().put("dir", project.absolutePath).put("file", rel).put("role", role).put("source", source)
            .put("originalName", name).put("capture", capture).put("sidecars", sidecars)
        if (hint != null) args.put("hint", hint)
        if (ext != "jpg" && ext != "png") {
            // platform-decoded lossless working copy; the original bytes stay in originals/
            val work = "work/$base-dev.png"
            try {
                developToPng(dst, File(project, work))
            } catch (e: Exception) {
                dst.delete()
                throw UserFacingException("This file format could not be decoded on this device (${e.message ?: ext}). Supported: JPEG, PNG, HEIC/HEIF, WebP, and RAW/DNG where the device provides a decoder.")
            }
            args.put("working", work)
            args.put("exif", exifJson(dst))
        }
        try {
            return Core.call("frame.add", args)
        } catch (e: Core.CoreException) {
            dst.delete()
            File(project, "work/$base-dev.png").delete()
            throw UserFacingException(e.message ?: "The photo could not be added.")
        }
    }

    private fun developToPng(src: File, dst: File) {
        val bmp: Bitmap = if (Build.VERSION.SDK_INT >= 28) {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(src)) { d, _, _ ->
                d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                d.isMutableRequired = false
            }  // applies EXIF orientation
        } else {
            val raw = BitmapFactory.decodeFile(src.absolutePath) ?: throw IllegalStateException("decoder returned nothing")
            val o = ExifInterface(src.absolutePath).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1)
            val m = Matrix()
            when (o) {
                3 -> m.postRotate(180f); 6 -> m.postRotate(90f); 8 -> m.postRotate(270f)
                2 -> m.postScale(-1f, 1f); 4 -> m.postScale(1f, -1f)
            }
            if (m.isIdentity) raw else Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, m, true)
        }
        val argb = if (bmp.config != Bitmap.Config.ARGB_8888) bmp.copy(Bitmap.Config.ARGB_8888, false) else bmp
        dst.parentFile?.mkdirs()
        FileOutputStream(dst).use { argb.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun exifJson(f: File): JSONObject {
        val o = JSONObject()
        runCatching {
            val e = ExifInterface(f.absolutePath)
            e.getAttribute(ExifInterface.TAG_MAKE)?.let { o.put("make", it) }
            e.getAttribute(ExifInterface.TAG_MODEL)?.let { o.put("model", it) }
            e.getAttribute(ExifInterface.TAG_LENS_MODEL)?.let { o.put("lens", it) }
            e.getAttributeDouble(ExifInterface.TAG_FOCAL_LENGTH, 0.0).takeIf { it > 0 }?.let { o.put("focalLength", it) }
            e.getAttributeDouble(ExifInterface.TAG_F_NUMBER, 0.0).takeIf { it > 0 }?.let { o.put("fNumber", it) }
            e.getAttributeDouble(ExifInterface.TAG_EXPOSURE_TIME, 0.0).takeIf { it > 0 }?.let { o.put("exposureTime", it) }
            e.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL)?.let { o.put("dateTime", it) }
        }
        return o
    }

    /**
     * Crash / kill recovery: photos that were captured or copied but not yet registered with the project
     * (the process died in between) are still on disk as originals/.incoming-*. Returns them for re-adoption.
     */
    fun pendingIncoming(project: File): List<File> =
        (File(project, "originals").listFiles() ?: emptyArray())
            .filter { it.name.startsWith(".incoming-") && it.length() > 0 && System.currentTimeMillis() - it.lastModified() > 15_000 }

    fun adoptIncoming(project: File, f: File) {
        val head = ByteArray(16)
        val n = f.inputStream().use { it.read(head) }
        val ext = sniff(head, n)
        registerFile(project, f, ext, "closeup", null, "recovered", "", JSONObject(), JSONArray())
    }

    // ---------------------------------------------------------------------------------------- archives
    /** Portable project archive: project.json (frames, transforms, edits), all originals, optionally the result. */
    fun writeArchive(project: Project, out: File, includeResult: Boolean, onProgress: (Double) -> Unit, cancelled: () -> Boolean) {
        val files = project.dir.walkTopDown().filter { it.isFile }.filter { f ->
            val rel = f.relativeTo(project.dir).path
            when {
                rel.startsWith("results/") && (!includeResult || rel.contains(".tmp/")) -> false
                rel.endsWith(".feat") || rel.endsWith(".tmp") || rel.contains("/.incoming-") -> false
                else -> true
            }
        }.toList()
        val total = files.sumOf { it.length() }.coerceAtLeast(1)
        requireSpace(total + 8L * 1024 * 1024, "write the project archive")
        var done = 0L
        val tmp = File(out.path + ".part")
        try {
            ZipOutputStream(FileOutputStream(tmp).buffered(1 shl 16)).use { zip ->
                val buf = ByteArray(1 shl 16)
                zip.setComment("Detailed Capture project archive v1")
                for (f in files) {
                    if (cancelled()) throw UserFacingException("Cancelled.")
                    val rel = f.relativeTo(project.dir).path
                    val e = ZipEntry("project/$rel")
                    val stored = rel.endsWith(".jpg") || rel.endsWith(".png") || rel.endsWith(".heic") || rel.endsWith(".dng")
                    if (stored) {  // already-compressed data: store, do not deflate
                        val crc = CRC32()
                        f.inputStream().use { ins -> while (true) { val n = ins.read(buf); if (n <= 0) break; crc.update(buf, 0, n) } }
                        e.method = ZipEntry.STORED; e.size = f.length(); e.compressedSize = f.length(); e.crc = crc.value
                    }
                    zip.putNextEntry(e)
                    f.inputStream().use { ins ->
                        while (true) {
                            val n = ins.read(buf); if (n <= 0) break
                            zip.write(buf, 0, n); done += n
                        }
                    }
                    zip.closeEntry()
                    onProgress(done.toDouble() / total)
                }
            }
            if (!tmp.renameTo(out)) throw UserFacingException("Could not finish writing the archive.")
        } catch (e: Exception) {
            tmp.delete(); throw e
        }
    }

    fun importArchive(uri: Uri): Project {
        val dir = File(root, "p" + System.currentTimeMillis().toString(36) + UUID.randomUUID().toString().take(4))
        val base = dir.canonicalPath + File.separator
        try {
            (appContext.contentResolver.openInputStream(uri) ?: throw UserFacingException("Could not open the archive.")).use { ins ->
                unzipInto(ins, dir, base)
            }
            if (!File(dir, "project.json").exists()) throw UserFacingException("This file is not a Detailed Capture project archive.")
            return load(dir, recover = true)
        } catch (e: Exception) {
            dir.deleteRecursively()
            if (e is UserFacingException) throw e
            throw UserFacingException("The archive could not be imported (${e.message}).")
        }
    }

    private fun unzipInto(ins: InputStream, dir: File, base: String) {
        ZipInputStream(ins.buffered(1 shl 16)).use { zip ->
            val buf = ByteArray(1 shl 16)
            while (true) {
                val e = zip.nextEntry ?: break
                if (e.isDirectory || !e.name.startsWith("project/")) continue
                val out = File(dir, e.name.removePrefix("project/"))
                if (!out.canonicalPath.startsWith(base)) throw UserFacingException("The archive contains an unsafe path.")  // zip-slip guard
                out.parentFile?.mkdirs()
                if (freeBytes() < 32L * 1024 * 1024) throw UserFacingException("Not enough free storage to import this archive.")
                FileOutputStream(out).use { o -> while (true) { val n = zip.read(buf); if (n <= 0) break; o.write(buf, 0, n) } }
            }
        }
    }

    /** Zips a directory (tile package) into one file. */
    fun zipDir(srcDir: File, out: File, onProgress: (Double) -> Unit, cancelled: () -> Boolean) {
        val files = srcDir.walkTopDown().filter { it.isFile }.toList()
        val total = files.sumOf { it.length() }.coerceAtLeast(1)
        requireSpace(total, "write the tile package")
        var done = 0L
        val tmp = File(out.path + ".part")
        try {
            ZipOutputStream(FileOutputStream(tmp).buffered(1 shl 16)).use { zip ->
                zip.setLevel(1)
                val buf = ByteArray(1 shl 16)
                for (f in files) {
                    if (cancelled()) throw UserFacingException("Cancelled.")
                    zip.putNextEntry(ZipEntry(srcDir.name + "/" + f.relativeTo(srcDir).path))
                    f.inputStream().use { ins -> while (true) { val n = ins.read(buf); if (n <= 0) break; zip.write(buf, 0, n); done += n } }
                    zip.closeEntry()
                    onProgress(done.toDouble() / total)
                }
            }
            if (!tmp.renameTo(out)) throw UserFacingException("Could not finish writing the package.")
        } catch (e: Exception) {
            tmp.delete(); throw e
        }
    }
}
