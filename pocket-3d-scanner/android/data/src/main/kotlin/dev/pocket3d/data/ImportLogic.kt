package dev.pocket3d.data

import dev.pocket3d.core.net.StatusResponse
import dev.pocket3d.core.project.Intrinsics
import java.time.DateTimeException
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.UUID
import kotlin.math.hypot

/*
 * Pure parts of the photo import (no Android): format sniffing, EXIF → intrinsics / timestamp
 * maths, naming and validation. Unit-tested on the JVM; AndroidPhotoImporter is the glue.
 */

/** Recognises the real format of a file from its first bytes — never from its name or MIME type. */
object ImageSniffer {
    /** Number of leading bytes [sniff] wants to see (fewer is fine for short files). */
    const val HEADER_BYTES = 64

    sealed interface Result {
        /** @param format jpeg | png | webp | heic */
        data class Supported(val format: String) : Result
        data class Rejected(val reason: String) : Result
    }

    private fun ByteArray.u(i: Int) = this[i].toInt() and 0xFF
    private fun ByteArray.ascii(from: Int, len: Int) = String(this, from, len, Charsets.ISO_8859_1)
    private fun ByteArray.startsWith(vararg b: Int): Boolean {
        if (size < b.size) return false
        for (i in b.indices) if (u(i) != b[i]) return false
        return true
    }

    private val HEIC_STILL = setOf("heic", "heix")
    private val HEIC_SEQUENCE = setOf("hevc", "hevx", "msf1")
    private val HEIC_OTHER = setOf("heim", "heis", "hevm", "hevs")

    /**
     * @param header the first bytes of the file (up to [HEADER_BYTES])
     * @param totalSize the file's full length in bytes
     */
    fun sniff(header: ByteArray, totalSize: Long): Result {
        if (totalSize == 0L || header.isEmpty()) return Result.Rejected("The file is empty.")
        val truncated = Result.Rejected("The file is cut off (only $totalSize bytes) — it is not a complete image.")
        return when {
            header.startsWith(0xFF, 0xD8) -> when {
                header.size < 3 -> truncated
                header.u(2) != 0xFF -> Result.Rejected("Damaged JPEG file (invalid header).")
                // No complete JPEG (tables + frame + scan) fits into this.
                totalSize < 64 -> truncated
                else -> Result.Supported("jpeg")
            }
            header.startsWith(0x89, 0x50, 0x4E, 0x47) || (header.size < 4 && header.startsWith(0x89)) -> when {
                header.size < 8 -> truncated
                !header.startsWith(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A) ->
                    Result.Rejected("Damaged PNG file (invalid signature).")
                // signature + IHDR + IDAT + IEND
                totalSize < 57 -> truncated
                header.size >= 16 && header.ascii(12, 4) != "IHDR" -> Result.Rejected("Damaged PNG file (missing header chunk).")
                else -> Result.Supported("png")
            }
            header.startsWith(0x52, 0x49, 0x46, 0x46) -> when {   // RIFF
                header.size < 12 -> truncated
                header.ascii(8, 4) != "WEBP" -> Result.Rejected("Unsupported file type (a RIFF container that is not a WebP image).")
                header.size < 16 || totalSize < 26 -> truncated
                header.ascii(12, 4) !in setOf("VP8 ", "VP8L", "VP8X") -> Result.Rejected("Damaged WebP file (unknown chunk).")
                else -> Result.Supported("webp")
            }
            header.size >= 8 && header.ascii(4, 4) == "ftyp" -> sniffIsoBmff(header, totalSize)
            header.startsWith(0x47, 0x49, 0x46, 0x38) -> Result.Rejected("GIF images are not supported. Use JPEG, PNG, WebP or HEIC photos.")
            header.startsWith(0x42, 0x4D) -> Result.Rejected("BMP images are not supported. Use JPEG, PNG, WebP or HEIC photos.")
            header.startsWith(0x49, 0x49, 0x2A, 0x00) || header.startsWith(0x4D, 0x4D, 0x00, 0x2A) ->
                Result.Rejected("TIFF and camera RAW (DNG) files are not supported. Export the photos as JPEG first.")
            header.startsWith(0x25, 0x50, 0x44, 0x46) -> Result.Rejected("This is a PDF document, not a photo.")
            header.startsWith(0xFF, 0x0A) || header.startsWith(0x00, 0x00, 0x00, 0x0C, 0x4A, 0x58, 0x4C, 0x20) ->
                Result.Rejected("JPEG XL images are not supported. Use JPEG, PNG, WebP or HEIC photos.")
            header.size < 12 && totalSize < 12 -> truncated
            else -> Result.Rejected("Not a supported image file (JPEG, PNG, WebP or HEIC expected).")
        }
    }

    private fun sniffIsoBmff(header: ByteArray, totalSize: Long): Result {
        val truncated = Result.Rejected("The file is cut off (only $totalSize bytes) — it is not a complete image.")
        if (header.size < 16) return truncated
        val boxSize = (header.u(0).toLong() shl 24) or (header.u(1).toLong() shl 16) or (header.u(2).toLong() shl 8) or header.u(3).toLong()
        if (boxSize < 16 || boxSize % 4 != 0L) return Result.Rejected("Damaged HEIC/MP4-family file (invalid header).")
        if (totalSize <= boxSize) return truncated
        val major = header.ascii(8, 4)
        val brands = LinkedHashSet<String>()
        brands += major
        var i = 16
        while (i + 4 <= header.size && i + 4 <= boxSize) { brands += header.ascii(i, 4); i += 4 }
        return when {
            major in HEIC_STILL || (major == "mif1" && brands.any { it in HEIC_STILL }) -> Result.Supported("heic")
            major == "avif" || major == "avis" || (major == "mif1" && "avif" in brands) ->
                Result.Rejected("AVIF images are not supported. Use JPEG, PNG, WebP or HEIC photos.")
            major in HEIC_SEQUENCE || (major == "msf1") ->
                Result.Rejected("This HEIC file is an image sequence (burst or live photo), not a single photo.")
            major in HEIC_OTHER -> Result.Rejected("This HEIC variant (multi-view / scalable coding) cannot be decoded.")
            major == "mif1" -> Result.Rejected("This HEIF file does not contain an HEVC-coded (HEIC) photo.")
            major == "crx " -> Result.Rejected("Camera RAW (CR3) files are not supported. Export the photos as JPEG first.")
            major.startsWith("qt") || major.startsWith("mp4") || major.startsWith("iso") || major.startsWith("M4V") ||
                major.startsWith("3gp") || major == "avc1" -> Result.Rejected("This is a video, not a photo.")
            else -> Result.Rejected("Not a supported image file (JPEG, PNG, WebP or HEIC expected).")
        }
    }
}

/** EXIF values of a photo, as read from the file. Every field may be absent. */
data class ExifData(
    val orientation: Int? = null,
    /** "YYYY:MM:DD HH:MM:SS" */
    val dateTimeOriginal: String? = null,
    val subSecTimeOriginal: String? = null,
    /** "+02:00" */
    val offsetTimeOriginal: String? = null,
    val focalLengthMm: Double? = null,
    val focalLength35mm: Double? = null,
    val focalPlaneXResolution: Double? = null,
    val focalPlaneYResolution: Double? = null,
    /** 2 = inch, 3 = cm, 4 = mm, 5 = µm (EXIF FocalPlaneResolutionUnit). */
    val focalPlaneResolutionUnit: Int? = null,
    val pixelXDimension: Int? = null,
    val pixelYDimension: Int? = null,
)

object ExifMath {
    /** Diagonal of the 36 × 24 mm frame that "35 mm equivalent" focal lengths refer to. */
    const val FULL_FRAME_DIAGONAL_MM = 43.2666

    fun normalizeOrientation(o: Int?): Int = if (o != null && o in 1..8) o else 1

    private fun plausible(fPx: Double, longSide: Int) = fPx.isFinite() && fPx > 0.3 * longSide && fPx < 8.0 * longSide

    /**
     * Pinhole intrinsics in pixels of the STORED (un-rotated) image, or null when EXIF does not
     * determine them reliably — a wrong "known" focal length is worse than none.
     *
     *  1. `FocalLengthIn35mmFilm`: f_px = f35 / 43.2666 · hypot(w, h). Survives resizing.
     *  2. `FocalLength` · `FocalPlaneXResolution`: pixels per mm of the sensor read-out — only
     *     trusted when `PixelXDimension`/`PixelYDimension` equal the stored size, i.e. the file
     *     was demonstrably not resized after capture.
     *
     * The principal point is assumed at the image centre.
     */
    fun intrinsics(width: Int, height: Int, exif: ExifData): Intrinsics? {
        if (width <= 0 || height <= 0) return null
        val longSide = maxOf(width, height)
        val cx = width / 2.0
        val cy = height / 2.0
        val f35 = exif.focalLength35mm
        if (f35 != null && f35 > 0 && f35.isFinite()) {
            val f = f35 / FULL_FRAME_DIAGONAL_MM * hypot(width.toDouble(), height.toDouble())
            if (plausible(f, longSide)) return Intrinsics(f, f, cx, cy, "exif")
        }
        val fmm = exif.focalLengthMm
        val unitMm = when (exif.focalPlaneResolutionUnit) {
            2 -> 25.4; 3 -> 10.0; 4 -> 1.0; 5 -> 0.001
            else -> null
        }
        val xRes = exif.focalPlaneXResolution
        if (fmm != null && fmm > 0 && fmm.isFinite() && unitMm != null && xRes != null && xRes > 0 && xRes.isFinite()) {
            // EXIF dimensions describe the image as displayed-or-stored depending on the writer:
            // accept either orientation, but only an exact match.
            val px = exif.pixelXDimension
            val py = exif.pixelYDimension
            val sameSize = px != null && py != null &&
                ((px == width && py == height) || (px == height && py == width))
            val widthOnly = px != null && py == null && px == width
            if (sameSize || widthOnly) {
                val fx = fmm * xRes / unitMm
                val yRes = exif.focalPlaneYResolution?.takeIf { it > 0 && it.isFinite() }
                val fyRaw = if (yRes != null) fmm * yRes / unitMm else fx
                // Non-square pixels beyond a few percent mean the tags are not what they claim.
                val fy = if (fyRaw / fx in 0.97..1.03) fyRaw else return null
                if (plausible(fx, longSide) && plausible(fy, longSide)) return Intrinsics(fx, fy, cx, cy, "exif")
            }
        }
        return null
    }

    private val DATE_TIME = Regex("^(\\d{4})[:\\-/](\\d{2})[:\\-/](\\d{2})[ T](\\d{2}):(\\d{2}):(\\d{2})$")
    private val OFFSET = Regex("^([+-])(\\d{2}):?(\\d{2})$")

    /**
     * Capture time in Unix milliseconds from `DateTimeOriginal` (+ sub-seconds, + UTC offset).
     * Without an offset tag the wall-clock time is interpreted in [fallbackZone].
     */
    fun timestampMs(dateTime: String?, subSec: String?, offset: String?, fallbackZone: ZoneId): Long? {
        val m = DATE_TIME.matchEntire(dateTime?.trim() ?: return null) ?: return null
        val (y, mo, d, h, mi, s) = m.destructured
        if (y.toInt() < 1971) return null   // "0000:00:00 00:00:00" and other unset clocks
        val local = try {
            LocalDateTime.of(y.toInt(), mo.toInt(), d.toInt(), h.toInt(), mi.toInt(), s.toInt())
        } catch (_: DateTimeException) {
            return null
        }
        val zoneOffset = offset?.trim()?.let { OFFSET.matchEntire(it) }?.let { om ->
            val secs = om.groupValues[2].toInt() * 3600 + om.groupValues[3].toInt() * 60
            if (secs > 18 * 3600) null else ZoneOffset.ofTotalSeconds(if (om.groupValues[1] == "-") -secs else secs)
        }
        val seconds = if (zoneOffset != null) local.toEpochSecond(zoneOffset) else local.atZone(fallbackZone).toEpochSecond()
        val digits = subSec?.trim()?.takeWhile { it.isDigit() }?.take(3) ?: ""
        val millis = if (digits.isEmpty()) 0 else digits.padEnd(3, '0').toInt()
        return seconds * 1000 + millis
    }
}

/** Names and limits for imported photos. */
object ImportRules {
    const val LOW_RESOLUTION_LONG_SIDE = 1000

    /** A fresh frame id: 16 hex characters, valid as a companion file id and as a file name. */
    fun newFrameId(): String = UUID.randomUUID().toString().replace("-", "").substring(0, 16)

    /**
     * Display name as shown to the user and sent as metadata. Never used as a path: directory
     * parts and control characters are removed anyway, and the length is bounded.
     */
    fun displayName(raw: String?, fallback: String): String {
        val base = (raw ?: "").substringAfterLast('/').substringAfterLast('\\')
        val cleaned = base.filter { !it.isISOControl() && it !in '\u202A'..'\u202E' && it !in '\u2066'..'\u2069' }.trim().take(200)
        return if (cleaned.isEmpty() || cleaned == "." || cleaned == "..") fallback else cleaned
    }

    /** Sample size (power of two) that keeps the decoded width at or just above [targetWidth]. */
    fun sampleSizeFor(width: Int, targetWidth: Int): Int {
        var sample = 1
        while (width / (sample * 2) >= targetWidth) sample *= 2
        return sample
    }

    /**
     * Reason why a photo of this size cannot be used, or null if it can.
     * @param limits the paired companion's limits when known, else the protocol defaults
     */
    fun checkLimits(width: Int, height: Int, sizeBytes: Long, limits: StatusResponse.Limits, format: String): String? {
        val pixels = width.toLong() * height
        return when {
            width <= 0 || height <= 0 -> "The image could not be decoded (damaged file)."
            format !in limits.formats -> "The companion does not accept ${format.uppercase()} photos."
            sizeBytes > limits.maxImageBytes ->
                "The file is larger than the companion accepts (${sizeBytes / 1_000_000} MB, limit ${limits.maxImageBytes / 1_000_000} MB)."
            pixels > limits.maxImagePixels ->
                "The image has more pixels than the companion accepts (${pixels / 1_000_000} MP, limit ${limits.maxImagePixels / 1_000_000} MP)."
            minOf(width, height) < limits.minImageSide ->
                "The image is too small for reconstruction ($width × $height px, at least ${limits.minImageSide} px per side needed)."
            else -> null
        }
    }
}
