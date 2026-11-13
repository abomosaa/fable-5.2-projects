package dev.pocket3d.data

import dev.pocket3d.core.net.StatusResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import kotlin.math.hypot

class ImportLogicTest {
    private fun bytes(vararg v: Int) = ByteArray(v.size) { v[it].toByte() }
    private fun supported(h: ByteArray, size: Long) = (ImageSniffer.sniff(h, size) as? ImageSniffer.Result.Supported)?.format
    private fun rejected(h: ByteArray, size: Long) = (ImageSniffer.sniff(h, size) as? ImageSniffer.Result.Rejected)?.reason

    private fun ftyp(major: String, vararg compat: String): ByteArray {
        val size = 16 + 4 * compat.size
        return bytes(0, 0, 0, size) + "ftyp".toByteArray() + major.toByteArray() + bytes(0, 0, 0, 0) +
            compat.fold(ByteArray(0)) { a, c -> a + c.toByteArray() } + ByteArray(32)
    }

    @Test fun formatIsDecidedByContentNotByName() {
        assertEquals("jpeg", supported(bytes(0xFF, 0xD8, 0xFF, 0xE1) + ByteArray(60), 500_000))
        assertEquals("png", supported(bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13) + "IHDR".toByteArray() + ByteArray(40), 90_000))
        assertEquals("webp", supported("RIFF".toByteArray() + bytes(1, 2, 3, 4) + "WEBPVP8 ".toByteArray() + ByteArray(40), 40_000))
        assertEquals("heic", supported(ftyp("heic", "mif1", "heic"), 2_000_000))
        assertEquals("heic", supported(ftyp("mif1", "mif1", "heic"), 2_000_000))
    }

    @Test fun unsupportedFilesGetASpecificReason() {
        assertTrue(rejected("GIF89a".toByteArray() + ByteArray(40), 5000)!!.contains("GIF"))
        assertTrue(rejected(bytes(0x49, 0x49, 0x2A, 0x00) + ByteArray(40), 5_000_000)!!.contains("RAW"))
        assertTrue(rejected("%PDF-1.7".toByteArray() + ByteArray(40), 5000)!!.contains("PDF"))
        assertTrue(rejected(ftyp("avif", "mif1", "avif"), 50_000)!!.contains("AVIF"))
        assertTrue(rejected(ftyp("isom", "mp42"), 9_000_000)!!.contains("video"))
        assertTrue(rejected(ftyp("hevc", "mif1"), 9_000_000)!!.contains("sequence"))
        assertTrue(rejected(ftyp("mif1", "mif1", "miaf"), 50_000)!!.contains("HEVC"))
        assertTrue(rejected("RIFF".toByteArray() + bytes(1, 2, 3, 4) + "WAVEfmt ".toByteArray() + ByteArray(40), 40_000)!!.contains("WebP"))
        assertNotNull(rejected("hello, this is text and not a photo at all".toByteArray(), 42))
    }

    @Test fun emptyTruncatedAndDamagedFiles() {
        assertTrue(rejected(ByteArray(0), 0)!!.contains("empty"))
        assertTrue(rejected(bytes(0xFF, 0xD8), 2)!!.contains("cut off"))
        assertTrue(rejected(bytes(0xFF, 0xD8, 0xFF, 0xE0) + ByteArray(20), 24)!!.contains("cut off"))
        assertTrue(rejected(bytes(0xFF, 0xD8, 0x00, 0x00) + ByteArray(60), 5000)!!.contains("Damaged"))
        assertTrue(rejected(bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A), 6)!!.contains("cut off"))
        assertTrue(rejected(bytes(0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4) + ByteArray(40), 5000)!!.contains("Damaged"))
        assertTrue(rejected(ftyp("heic", "mif1"), 20)!!.contains("cut off"))
    }

    @Test fun focalLengthFrom35mmEquivalentSurvivesResizing() {
        val full = ExifMath.intrinsics(4000, 3000, ExifData(focalLength35mm = 26.0))!!
        assertEquals(26.0 / 43.2666 * hypot(4000.0, 3000.0), full.fx, 1e-6)
        assertEquals(full.fx, full.fy, 0.0); assertEquals(2000.0, full.cx, 0.0); assertEquals(1500.0, full.cy, 0.0)
        assertEquals("exif", full.source)
        val resized = ExifMath.intrinsics(1000, 750, ExifData(focalLength35mm = 26.0))!!
        assertEquals(full.fx / 4, resized.fx, 1e-6)
        // portrait-stored image: same focal in pixels
        assertEquals(full.fx, ExifMath.intrinsics(3000, 4000, ExifData(focalLength35mm = 26.0))!!.fx, 1e-6)
    }

    @Test fun focalPlaneResolutionIsOnlyTrustedWhenTheFileWasNotResized() {
        // Canon T4i: 30 mm, 5184 px across 22.3 mm => 232.47 px/mm => 5798.66 px/inch… given per inch
        val exif = ExifData(focalLengthMm = 30.0, focalPlaneXResolution = 5798.66, focalPlaneYResolution = 5788.94,
                            focalPlaneResolutionUnit = 2)
        assertNull(ExifMath.intrinsics(5184, 3456, exif))                                   // no PixelXDimension: unknown
        assertNull(ExifMath.intrinsics(1200, 800, exif.copy(pixelXDimension = 5184, pixelYDimension = 3456)))  // resized
        val k = ExifMath.intrinsics(5184, 3456, exif.copy(pixelXDimension = 5184, pixelYDimension = 3456))!!
        assertEquals(30.0 * 5798.66 / 25.4, k.fx, 1e-6)
        assertEquals(30.0 * 5788.94 / 25.4, k.fy, 1e-6)
        // rotated EXIF dimensions are the same image
        assertNotNull(ExifMath.intrinsics(3456, 5184, exif.copy(pixelXDimension = 5184, pixelYDimension = 3456)))
        // clearly non-square pixels => tags are not what they claim
        assertNull(ExifMath.intrinsics(5184, 3456, exif.copy(focalPlaneYResolution = 9000.0, pixelXDimension = 5184, pixelYDimension = 3456)))
    }

    @Test fun implausibleOrMissingMetadataGivesNoIntrinsics() {
        assertNull(ExifMath.intrinsics(4000, 3000, ExifData()))
        assertNull(ExifMath.intrinsics(4000, 3000, ExifData(focalLength35mm = 0.0)))
        assertNull(ExifMath.intrinsics(4000, 3000, ExifData(focalLength35mm = 4000.0)))      // > 8x the long side
        assertNull(ExifMath.intrinsics(4000, 3000, ExifData(focalLength35mm = Double.NaN)))
        assertNull(ExifMath.intrinsics(0, 0, ExifData(focalLength35mm = 26.0)))
        assertEquals(1, ExifMath.normalizeOrientation(null)); assertEquals(1, ExifMath.normalizeOrientation(9))
        assertEquals(6, ExifMath.normalizeOrientation(6))
    }

    @Test fun captureTimeParsing() {
        val utc = ZoneId.of("UTC")
        assertEquals(1_700_000_000_000L, ExifMath.timestampMs("2023:11:14 22:13:20", null, null, utc))
        assertEquals(1_700_000_000_250L, ExifMath.timestampMs("2023:11:14 22:13:20", "25", null, utc))
        assertEquals(1_700_000_000_000L - 7_200_000L, ExifMath.timestampMs("2023:11:14 22:13:20", null, "+02:00", utc))
        assertEquals(1_700_000_000_000L + 3_600_000L, ExifMath.timestampMs("2023:11:14 22:13:20", null, null, ZoneId.of("-01:00")))
        assertNull(ExifMath.timestampMs("0000:00:00 00:00:00", null, null, utc))
        assertNull(ExifMath.timestampMs("2023:13:40 99:99:99", null, null, utc))
        assertNull(ExifMath.timestampMs("yesterday", null, null, utc))
        assertNull(ExifMath.timestampMs(null, null, null, utc))
    }

    @Test fun namesAreNeverPathsAndLimitsAreExplained() {
        assertEquals("IMG_1.jpg", ImportRules.displayName("../../etc/IMG_1.jpg", "photo"))
        assertEquals("b.jpg", ImportRules.displayName("C:\\a\\b.jpg", "photo"))
        assertEquals("photo", ImportRules.displayName("..", "photo"))
        assertEquals("photo", ImportRules.displayName(null, "photo"))
        assertEquals("ab.jpg", ImportRules.displayName("a\u0000\u202Eb.jpg", "photo"))
        assertEquals(200, ImportRules.displayName("x".repeat(500), "photo").length)
        assertTrue(ImportRules.newFrameId().matches(Regex("^[0-9a-f]{16}$")))
        assertEquals(8, ImportRules.sampleSizeFor(4000, 480)); assertEquals(1, ImportRules.sampleSizeFor(600, 480))
        val lim = StatusResponse.Limits()
        assertNull(ImportRules.checkLimits(4000, 3000, 5_000_000, lim, "jpeg"))
        assertTrue(ImportRules.checkLimits(4000, 3000, 80_000_000, lim, "jpeg")!!.contains("larger"))
        assertTrue(ImportRules.checkLimits(12000, 9000, 5_000_000, lim, "jpeg")!!.contains("pixels"))
        assertTrue(ImportRules.checkLimits(300, 200, 50_000, lim, "jpeg")!!.contains("too small"))
        assertTrue(ImportRules.checkLimits(4000, 3000, 5_000_000, lim.copy(formats = listOf("jpeg")), "heic")!!.contains("HEIC"))
        assertTrue(ImportRules.checkLimits(0, 0, 5_000, lim, "jpeg")!!.contains("decoded"))
    }
}
