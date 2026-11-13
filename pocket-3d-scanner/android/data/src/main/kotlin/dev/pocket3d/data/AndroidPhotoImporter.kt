package dev.pocket3d.data

import android.content.ContentResolver
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import androidx.exifinterface.media.ExifInterface
import dev.pocket3d.core.capture.FrameAnalysis
import dev.pocket3d.core.net.StatusResponse
import dev.pocket3d.core.project.Frame
import dev.pocket3d.core.project.FrameFlag
import dev.pocket3d.core.services.ImportIssue
import dev.pocket3d.core.services.ImportReport
import dev.pocket3d.core.services.PhotoImporter
import dev.pocket3d.core.services.ProjectStore
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.time.ZoneId
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.coroutineContext

/**
 * Imports user-selected photos into a capture session. The bytes are copied untouched — never
 * re-encoded — and each file is decoded once (down-sampled) to validate it and measure quality.
 * The pure decisions live in [ImageSniffer], [ExifMath] and [ImportRules].
 *
 * Storage: if the sizes reported by the picker already exceed the free space (minus a 50 MB
 * reserve) nothing is imported and [InsufficientStorageException] is thrown. If the phone
 * fills up while copying, the photos imported so far are kept and every remaining one is
 * reported as an issue.
 *
 * @param limits the paired companion's limits when known (null → protocol defaults)
 */
class AndroidPhotoImporter(
    context: Context,
    private val store: ProjectStore,
    private val limits: () -> StatusResponse.Limits? = { null },
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : PhotoImporter {

    private val resolver: ContentResolver = context.applicationContext.contentResolver
    /** dHash by content SHA-256 of photos already analysed in this process. */
    private val hashCache = ConcurrentHashMap<String, Long>()

    private class Source(val uri: Uri, val name: String, val size: Long?)
    private class Rejected(val reason: String) : Exception(reason)

    override suspend fun importPhotos(projectId: String, sessionId: String, uris: List<String>,
                                      onProgress: (done: Int, total: Int) -> Unit): ImportReport = withContext(io) {
        val session = store.session(projectId, sessionId) ?: throw IllegalArgumentException("unknown capture session")
        val lim = limits() ?: StatusResponse.Limits()
        val sources = uris.mapIndexed { i, s -> describe(Uri.parse(s), i) }

        val knownTotal = sources.sumOf { it.size ?: 0L }
        val free = store.freeBytes()
        if (free < knownTotal + FileProjectStore.RESERVE_BYTES) throw InsufficientStorageException(knownTotal, free)

        // Fingerprints of what is already in the session, for duplicate detection.
        val seenSha = HashSet<String>()
        val seenHashes = ArrayList<Long>()
        for (f in session.frames) {
            coroutineContext.ensureActive()
            seenSha += f.sha256
            var h = hashCache[f.sha256]
            if (h == null) {
                h = try {
                    analysisLuma(store.frameFile(projectId, sessionId, f))?.let { (luma, w, hgt) -> FrameAnalysis.dHash(luma, w, hgt) }
                } catch (_: Exception) {
                    null
                }
                if (h != null) hashCache[f.sha256] = h
            }
            if (h != null) seenHashes += h
        }

        val imported = ArrayList<Frame>()
        val issues = ArrayList<ImportIssue>()
        var storageFull = false
        onProgress(0, sources.size)
        for ((i, src) in sources.withIndex()) {
            coroutineContext.ensureActive()
            if (storageFull) {
                issues += ImportIssue(src.name, "Not imported: the phone ran out of free storage.")
            } else {
                try {
                    imported += importOne(projectId, sessionId, src, lim, seenSha, seenHashes)
                } catch (e: Rejected) {
                    issues += ImportIssue(src.name, e.reason)
                } catch (_: InsufficientStorageException) {
                    storageFull = true
                    issues += ImportIssue(src.name, "Not imported: the phone ran out of free storage.")
                } catch (_: SecurityException) {
                    issues += ImportIssue(src.name, "The app was not given access to this file.")
                } catch (_: IOException) {
                    issues += ImportIssue(src.name, "The file could not be read.")
                } catch (_: OutOfMemoryError) {
                    issues += ImportIssue(src.name, "The image is too large to open on this phone.")
                }
            }
            onProgress(i + 1, sources.size)
        }
        ImportReport(imported, issues)
    }

    private fun describe(uri: Uri, index: Int): Source {
        var name: String? = null
        var size: Long? = null
        if (uri.scheme == ContentResolver.SCHEME_CONTENT) {
            try {
                resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                    if (c.moveToFirst()) {
                        val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        val si = c.getColumnIndex(OpenableColumns.SIZE)
                        if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni)
                        if (si >= 0 && !c.isNull(si)) size = c.getLong(si).takeIf { it > 0 }
                    }
                }
            } catch (_: Exception) {
                // Providers may refuse the query; the bytes can often still be opened.
            }
        } else if (uri.scheme == ContentResolver.SCHEME_FILE) {
            uri.path?.let { p -> File(p).let { f -> name = f.name; size = f.length().takeIf { it > 0 } } }
        }
        return Source(uri, ImportRules.displayName(name ?: uri.lastPathSegment, "Photo ${index + 1}"), size)
    }

    private suspend fun importOne(projectId: String, sessionId: String, src: Source, lim: StatusResponse.Limits,
                                  seenSha: MutableSet<String>, seenHashes: MutableList<Long>): Frame {
        if (src.uri.scheme != ContentResolver.SCHEME_CONTENT && src.uri.scheme != ContentResolver.SCHEME_FILE) {
            throw Rejected("Unsupported source (only files and gallery items can be imported).")
        }
        if (src.size != null && src.size > lim.maxImageBytes) {
            throw Rejected("The file is larger than the companion accepts (${src.size / 1_000_000} MB, " +
                "limit ${lim.maxImageBytes / 1_000_000} MB).")
        }
        val temp = store.newFrameTempFile(projectId, sessionId)
        try {
            val size = copy(src, temp, lim.maxImageBytes)

            val header = ByteArray(ImageSniffer.HEADER_BYTES)
            val headerLen = FileInputStream(temp).use { input ->
                var n = 0
                while (n < header.size) { val r = input.read(header, n, header.size - n); if (r < 0) break; n += r }
                n
            }
            val format = when (val r = ImageSniffer.sniff(header.copyOf(headerLen), size)) {
                is ImageSniffer.Result.Supported -> r.format
                is ImageSniffer.Result.Rejected -> throw Rejected(r.reason)
            }

            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(temp.path, bounds)
            val width = bounds.outWidth
            val height = bounds.outHeight
            if (width <= 0 || height <= 0) throw Rejected(undecodable(format))
            ImportRules.checkLimits(width, height, size, lim, format)?.let { throw Rejected(it) }

            // One real (down-sampled) decode: proves the pixel data is readable and feeds the metrics.
            val (luma, lw, lh) = analysisLuma(temp, width) ?: throw Rejected(undecodable(format))
            val (quality, qualityFlags) = FrameAnalysis.analyze(luma, lw, lh)
            val hash = FrameAnalysis.dHash(luma, lw, lh)

            val exif = readExif(temp)
            val intrinsics = ExifMath.intrinsics(width, height, exif)
            val flags = ArrayList<String>(qualityFlags)
            if (maxOf(width, height) < ImportRules.LOW_RESOLUTION_LONG_SIDE) flags += FrameFlag.LOW_RESOLUTION
            if (intrinsics == null) flags += FrameFlag.NO_METADATA

            val draft = Frame(
                id = ImportRules.newFrameId(), name = src.name, file = "",
                timestampMs = ExifMath.timestampMs(exif.dateTimeOriginal, exif.subSecTimeOriginal, exif.offsetTimeOriginal,
                    ZoneId.systemDefault()),
                width = width, height = height, exifOrientation = ExifMath.normalizeOrientation(exif.orientation),
                intrinsics = intrinsics, quality = quality, flags = flags, format = format,
            )
            var stored = store.commitFrame(projectId, sessionId, draft, temp)
            // Same bytes as an earlier photo, or a near-identical view of one.
            val duplicate = stored.sha256 in seenSha ||
                seenHashes.any { FrameAnalysis.hammingDistance(it, hash) <= FrameAnalysis.DUPLICATE_HASH_DISTANCE }
            if (duplicate) {
                store.updateFrame(projectId, sessionId, stored.id) { it.copy(flags = it.flags + FrameFlag.DUPLICATE) }
                stored = stored.copy(flags = stored.flags + FrameFlag.DUPLICATE)
            }
            seenSha += stored.sha256
            seenHashes += hash
            hashCache[stored.sha256] = hash
            return stored
        } finally {
            if (temp.exists()) temp.delete()
        }
    }

    private fun undecodable(format: String) =
        if (format == "heic") "This HEIC photo uses a variant this phone cannot decode. Convert it to JPEG and import again."
        else "The image data is damaged and cannot be decoded."

    /** Byte-for-byte copy. Stops early when the file exceeds the limit or the phone fills up. */
    private suspend fun copy(src: Source, dest: File, maxBytes: Long): Long {
        val input = resolver.openInputStream(src.uri) ?: throw IOException("cannot open source")
        var total = 0L
        var sinceCheck = 0L
        input.use { ins ->
            FileOutputStream(dest).use { out ->
                val buf = ByteArray(256 * 1024)
                while (true) {
                    coroutineContext.ensureActive()
                    val n = ins.read(buf)
                    if (n < 0) break
                    total += n
                    if (total > maxBytes) {
                        throw Rejected("The file is larger than the companion accepts (limit ${maxBytes / 1_000_000} MB).")
                    }
                    sinceCheck += n
                    if (sinceCheck >= STORAGE_CHECK_INTERVAL) {
                        sinceCheck = 0
                        val free = store.freeBytes()
                        if (free < FileProjectStore.RESERVE_BYTES) throw InsufficientStorageException(total, free)
                    }
                    out.write(buf, 0, n)
                }
                out.flush()
                out.fd.sync()
            }
        }
        if (total == 0L) throw Rejected("The file is empty.")
        return total
    }

    /** Luma plane of the image, box-filtered to [FrameAnalysis.ANALYSIS_WIDTH] columns; null if undecodable. */
    private fun analysisLuma(file: File, knownWidth: Int = 0): Triple<ByteArray, Int, Int>? {
        var width = knownWidth
        if (width <= 0) {
            val b = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.path, b)
            width = b.outWidth
            if (width <= 0) return null
        }
        val opts = BitmapFactory.Options().apply {
            inSampleSize = ImportRules.sampleSizeFor(width, FrameAnalysis.ANALYSIS_WIDTH)
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        val bitmap = BitmapFactory.decodeFile(file.path, opts) ?: return null
        try {
            val w = bitmap.width
            val h = bitmap.height
            if (w <= 0 || h <= 0) return null
            val luma = ByteArray(w * h)
            val row = IntArray(w)
            for (y in 0 until h) {
                bitmap.getPixels(row, 0, w, 0, y, w, 1)
                val base = y * w
                for (x in 0 until w) {
                    val p = row[x]
                    // BT.601 luma, integer arithmetic
                    luma[base + x] = ((((p shr 16) and 0xFF) * 77 + ((p shr 8) and 0xFF) * 150 + (p and 0xFF) * 29) shr 8).toByte()
                }
            }
            return FrameAnalysis.downsample(luma, w, h)
        } finally {
            bitmap.recycle()
        }
    }

    private fun readExif(file: File): ExifData = try {
        val e = ExifInterface(file)
        fun positive(tag: String) = e.getAttributeDouble(tag, 0.0).takeIf { it > 0 && it.isFinite() }
        fun positiveInt(tag: String) = e.getAttributeInt(tag, 0).takeIf { it > 0 }
        ExifData(
            orientation = e.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL),
            dateTimeOriginal = e.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL) ?: e.getAttribute(ExifInterface.TAG_DATETIME),
            subSecTimeOriginal = e.getAttribute(ExifInterface.TAG_SUBSEC_TIME_ORIGINAL),
            offsetTimeOriginal = e.getAttribute(ExifInterface.TAG_OFFSET_TIME_ORIGINAL),
            focalLengthMm = positive(ExifInterface.TAG_FOCAL_LENGTH),
            focalLength35mm = positiveInt(ExifInterface.TAG_FOCAL_LENGTH_IN_35MM_FILM)?.toDouble(),
            focalPlaneXResolution = positive(ExifInterface.TAG_FOCAL_PLANE_X_RESOLUTION),
            focalPlaneYResolution = positive(ExifInterface.TAG_FOCAL_PLANE_Y_RESOLUTION),
            // EXIF: the unit defaults to inches when the tag is absent.
            focalPlaneResolutionUnit = positiveInt(ExifInterface.TAG_FOCAL_PLANE_RESOLUTION_UNIT) ?: 2,
            pixelXDimension = positiveInt(ExifInterface.TAG_PIXEL_X_DIMENSION),
            pixelYDimension = positiveInt(ExifInterface.TAG_PIXEL_Y_DIMENSION),
        )
    } catch (_: Exception) {
        ExifData()
    }

    private companion object {
        const val STORAGE_CHECK_INTERVAL = 4L * 1024 * 1024
    }
}
