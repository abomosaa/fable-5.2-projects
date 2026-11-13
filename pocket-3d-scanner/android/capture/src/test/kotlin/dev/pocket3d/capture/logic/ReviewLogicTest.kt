package dev.pocket3d.capture.logic

import dev.pocket3d.core.net.StatusResponse
import dev.pocket3d.core.project.Frame
import dev.pocket3d.core.project.FrameFlag
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReviewLogicTest {
    private fun frame(id: String, name: String = "$id.jpg", ts: Long? = null, flags: List<String> = emptyList(),
                      excluded: Boolean = false) =
        Frame(id = id, name = name, file = "$id.jpg", timestampMs = ts, flags = flags, excluded = excluded)

    private fun frames(n: Int, excluded: Int = 0) =
        (0 until n).map { frame("f$it", ts = it.toLong(), excluded = it < excluded) }

    // --- natural ordering -------------------------------------------------------------------

    @Test fun naturalCompare_ordersNumbersByValueNotByText() {
        assertTrue(ReviewLogic.naturalCompare("IMG_2.jpg", "IMG_10.jpg") < 0)
        assertTrue(ReviewLogic.naturalCompare("IMG_10.jpg", "IMG_9.jpg") > 0)
        assertTrue(ReviewLogic.naturalCompare("a100b2", "a100b10") < 0)
    }

    @Test fun naturalCompare_isCaseInsensitiveAndIgnoresLeadingZeros() {
        assertTrue(ReviewLogic.naturalCompare("img_3.JPG", "IMG_12.jpg") < 0)
        assertTrue(ReviewLogic.naturalCompare("IMG_007.jpg", "IMG_8.jpg") < 0)
        assertTrue(ReviewLogic.naturalCompare("IMG_0010.jpg", "IMG_9.jpg") > 0)
    }

    @Test fun naturalCompare_handlesNumbersLongerThanLong() {
        val a = "20240101123000123456789012345678901.jpg"
        val b = "20240101123000123456789012345678902.jpg"
        assertTrue(ReviewLogic.naturalCompare(a, b) < 0)
        assertTrue(ReviewLogic.naturalCompare(b, a) > 0)
    }

    @Test fun naturalCompare_isAConsistentTotalOrder() {
        assertEquals(0, ReviewLogic.naturalCompare("same.jpg", "same.jpg"))
        // Equal under natural rules but different strings: must not compare as 0, and must be antisymmetric.
        val x = ReviewLogic.naturalCompare("IMG_01.jpg", "IMG_1.jpg")
        val y = ReviewLogic.naturalCompare("IMG_1.jpg", "IMG_01.jpg")
        assertTrue(x != 0 && y != 0 && (x < 0) != (y < 0))
        assertTrue(ReviewLogic.naturalCompare("IMG_1", "IMG_1.jpg") < 0)
    }

    @Test fun orderByName_sortsNaturally() {
        val input = listOf(frame("a", "IMG_10.jpg"), frame("b", "IMG_2.jpg"), frame("c", "img_1.jpg"), frame("d", "DSC_5.jpg"))
        assertEquals(listOf("d", "c", "b", "a"), ReviewLogic.orderedIds(input, ReviewLogic.ORDER_NAME))
    }

    @Test fun orderByTime_putsMissingTimestampsLastAndBreaksTiesByName() {
        val input = listOf(
            frame("n2", "zz_no_time_10.jpg", ts = null),
            frame("t3", "c.jpg", ts = 3000),
            frame("n1", "zz_no_time_9.jpg", ts = null),
            frame("t1b", "b.jpg", ts = 1000),
            frame("t1a", "a.jpg", ts = 1000),
        )
        assertEquals(listOf("t1a", "t1b", "t3", "n1", "n2"), ReviewLogic.orderedIds(input, ReviewLogic.ORDER_TIME))
    }

    @Test fun manualOrUnknownOrdering_keepsStoredOrder() {
        val input = listOf(frame("b", ts = 2), frame("a", ts = 1))
        assertEquals(listOf("b", "a"), ReviewLogic.orderedIds(input, ReviewLogic.ORDER_MANUAL))
        assertEquals(listOf("b", "a"), ReviewLogic.orderedIds(input, "something-else"))
        assertNull(ReviewLogic.comparator(ReviewLogic.ORDER_MANUAL))
    }

    @Test fun ordering_keepsEveryFrameExactlyOnce() {
        val input = (0 until 40).map { frame("id$it", "IMG_${(it * 7) % 13}.jpg", ts = if (it % 5 == 0) null else (it % 6).toLong()) }
        for (o in listOf(ReviewLogic.ORDER_TIME, ReviewLogic.ORDER_NAME)) {
            val ids = ReviewLogic.orderedIds(input, o)
            assertEquals(input.size, ids.size)
            assertEquals(input.map { it.id }.toSet(), ids.toSet())
        }
    }

    // --- flags ------------------------------------------------------------------------------

    @Test fun flagCounts_countIncludedPhotosOnlyInDisplayOrder() {
        val input = listOf(
            frame("a", flags = listOf(FrameFlag.DARK, FrameFlag.BLUR)),
            frame("b", flags = listOf(FrameFlag.BLUR)),
            frame("c", flags = listOf(FrameFlag.BLUR, FrameFlag.DUPLICATE), excluded = true),
            frame("d", flags = listOf("zz_custom", FrameFlag.NO_METADATA)),
            frame("e"),
        )
        assertEquals(
            listOf(FrameFlag.BLUR to 2, FrameFlag.DARK to 1, FrameFlag.NO_METADATA to 1, "zz_custom" to 1),
            ReviewLogic.flagCounts(input),
        )
    }

    @Test fun flagCounts_countAPhotoOncePerFlagEvenIfRepeated() {
        val input = listOf(frame("a", flags = listOf(FrameFlag.BLUR, FrameFlag.BLUR)))
        assertEquals(listOf(FrameFlag.BLUR to 1), ReviewLogic.flagCounts(input))
    }

    @Test fun flaggedIncludedIds_skipsExcludedAndCleanPhotos() {
        val input = listOf(
            frame("a", flags = listOf(FrameFlag.BLUR)), frame("b"),
            frame("c", flags = listOf(FrameFlag.DARK), excluded = true), frame("d", flags = listOf(FrameFlag.LOW_OVERLAP)),
        )
        assertEquals(listOf("a", "d"), ReviewLogic.flaggedIncludedIds(input))
    }

    @Test fun shortFlagLabel_dropsTheAdvicePart() {
        assertEquals("Blurry", ReviewLogic.shortFlagLabel(FrameFlag.BLUR))
        assertEquals("Too dark", ReviewLogic.shortFlagLabel(FrameFlag.DARK))
        assertEquals("Low resolution", ReviewLogic.shortFlagLabel(FrameFlag.LOW_RESOLUTION))
        assertEquals("unknown_flag", ReviewLogic.shortFlagLabel("unknown_flag"))
    }

    // --- summary ----------------------------------------------------------------------------

    @Test fun summary_countsIncludedAndExcluded() {
        val s = ReviewLogic.summarize(frames(30, excluded = 4), null)
        assertEquals(30, s.total)
        assertEquals(26, s.included)
        assertEquals(4, s.excluded)
        assertTrue(s.canContinue)
        assertNull(s.blockReason)
        assertTrue(s.notices.isEmpty())
    }

    @Test fun summary_warnsBelowTwentyIncludedButStillAllowsContinue() {
        val s = ReviewLogic.summarize(frames(25, excluded = 6), null)
        assertEquals(19, s.included)
        assertTrue(s.canContinue)
        val warn = s.notices.single { it.severity == ReviewLogic.Severity.WARN }
        assertTrue(warn.title.contains("usually too few"))
        assertTrue(warn.title.contains("19"))
    }

    @Test fun summary_exactlyTwentyIncludedHasNoTooFewWarning() {
        val s = ReviewLogic.summarize(frames(20), null)
        assertTrue(s.notices.none { it.title.contains("too few") })
    }

    @Test fun summary_blocksBelowFallbackMinimumWhenCompanionUnknown() {
        val s = ReviewLogic.summarize(frames(2), null)
        assertFalse(s.canContinue)
        assertNotNull(s.blockReason)
        assertTrue(s.blockReason!!.contains("3"))
        assertEquals(ReviewLogic.FALLBACK_MIN_PHOTOS, s.minRequired)
        assertFalse(s.limitsFromCompanion)
        assertEquals(1, s.notices.count { it.severity == ReviewLogic.Severity.BLOCK })
        // The blocking notice replaces the softer "too few" warning rather than doubling it.
        assertTrue(s.notices.none { it.severity == ReviewLogic.Severity.WARN })
        assertTrue(ReviewLogic.summarize(frames(3), null).canContinue)
    }

    @Test fun summary_usesCompanionMinimumAndMaximumWhenKnown() {
        val limits = StatusResponse.Limits(maxImages = 50, minImages = 8)
        val below = ReviewLogic.summarize(frames(7), limits)
        assertFalse(below.canContinue)
        assertTrue(below.blockReason!!.contains("companion") && below.blockReason!!.contains("8"))
        assertTrue(below.limitsFromCompanion)
        assertEquals("Companion accepts 8–50 photos", below.limitsText)

        assertTrue(ReviewLogic.summarize(frames(8), limits).canContinue)

        val above = ReviewLogic.summarize(frames(53), limits)
        assertTrue(above.canContinue)
        val notice = above.notices.single { it.severity == ReviewLogic.Severity.WARN }
        assertTrue(notice.body!!.contains("at most 50") && notice.body!!.contains("Exclude 3"))
    }

    @Test fun summary_excludedPhotosDoNotCountTowardsTheMinimum() {
        val s = ReviewLogic.summarize(frames(10, excluded = 10), null)
        assertEquals(0, s.included)
        assertFalse(s.canContinue)
        assertTrue(s.blockReason!!.contains("No photos are included"))
    }

    @Test fun summary_emptySessionAsksForPhotos() {
        val s = ReviewLogic.summarize(emptyList(), null)
        assertFalse(s.canContinue)
        assertEquals("Add photos to continue.", s.blockReason)
        assertTrue(s.flagCounts.isEmpty())
    }

    @Test fun summary_reportsFlaggedIncludedPhotos() {
        val input = frames(30) + frame("x", flags = listOf(FrameFlag.BLUR)) +
            frame("y", flags = listOf(FrameFlag.DARK), excluded = true)
        val s = ReviewLogic.summarize(input, null)
        assertEquals(1, s.flaggedIncluded)
        val info = s.notices.single { it.severity == ReviewLogic.Severity.INFO }
        assertTrue(info.title.startsWith("1 included photo has"))
        assertEquals(listOf(FrameFlag.BLUR to 1), s.flagCounts)
    }

    @Test fun summary_limitsTextSaysUnknownWithoutCompanion() {
        assertTrue(ReviewLogic.summarize(frames(30), null).limitsText.contains("unknown"))
    }

    // --- thumbnails -------------------------------------------------------------------------

    @Test fun sampleSize_keepsShortSideAtOrAboveTarget() {
        assertEquals(8, ReviewLogic.sampleSize(4032, 3024, 256))   // 3024/8 = 378 >= 256, /16 = 189 < 256
        assertEquals(8, ReviewLogic.sampleSize(3024, 4032, 256))
        assertEquals(2, ReviewLogic.sampleSize(4032, 3024, 900))
        assertEquals(1, ReviewLogic.sampleSize(640, 480, 256))
        assertEquals(1, ReviewLogic.sampleSize(200, 100, 256))
    }

    @Test fun sampleSize_isSafeForDegenerateInput() {
        assertEquals(1, ReviewLogic.sampleSize(0, 0, 256))
        assertEquals(1, ReviewLogic.sampleSize(-1, 100, 256))
        assertEquals(1, ReviewLogic.sampleSize(4000, 3000, 0))
        assertEquals(64, ReviewLogic.sampleSize(1_000_000, 1_000_000, 1))
    }
}
