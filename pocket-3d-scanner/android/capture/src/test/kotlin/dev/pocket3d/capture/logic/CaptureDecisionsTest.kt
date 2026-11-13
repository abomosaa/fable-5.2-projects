package dev.pocket3d.capture.logic

import dev.pocket3d.core.capture.ViewSpacing
import dev.pocket3d.core.project.FrameFlag
import dev.pocket3d.core.project.FrameQuality
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CaptureDecisionsTest {
    private val ready = AutoCaptureInput(
        enabled = true, armed = true, trackingRequired = true, trackingOk = true,
        nearestKeptDeg = 14.0, angularSpeedDegS = 6.0, linearSpeedMS = 0.1, liveFlags = emptyList(),
        busy = false, storageBlocked = false, msSinceLastCapture = 5_000,
    )

    @Test fun firesWhenFarEnoughSteadyAndSharp() {
        assertEquals(AutoDecision.FIRE, AutoCaptureDecider.decide(ready))
        assertTrue(AutoDecision.FIRE.fire)
        // Exactly one target step away is enough; nothing kept yet (+∞) is enough too.
        assertEquals(AutoDecision.FIRE, AutoCaptureDecider.decide(ready.copy(nearestKeptDeg = ViewSpacing.TARGET_STEP_DEG)))
        assertEquals(AutoDecision.FIRE, AutoCaptureDecider.decide(ready.copy(nearestKeptDeg = Double.POSITIVE_INFINITY)))
    }

    @Test fun neverFiresWhileTrackingIsLost() {
        val angles = listOf(0.0, 5.0, 12.0, 40.0, 180.0, Double.POSITIVE_INFINITY)
        val speeds = listOf(0.0, 5.0, 24.0)
        for (a in angles) for (s in speeds) for (armed in listOf(true, false)) for (since in listOf(0L, 10_000L)) {
            val d = AutoCaptureDecider.decide(ready.copy(trackingOk = false, nearestKeptDeg = a, angularSpeedDegS = s,
                                                         armed = armed, msSinceLastCapture = since))
            assertFalse("angle=$a speed=$s armed=$armed", d.fire)
            assertEquals(AutoDecision.TRACKING_LOST, d)
        }
    }

    @Test fun orientationEngineDoesNotNeedTracking() {
        val imu = ready.copy(trackingRequired = false, trackingOk = false, linearSpeedMS = null)
        assertEquals(AutoDecision.FIRE, AutoCaptureDecider.decide(imu))
    }

    @Test fun holdsForEveryOtherReason() {
        assertEquals(AutoDecision.DISABLED, AutoCaptureDecider.decide(ready.copy(enabled = false)))
        assertEquals(AutoDecision.NOT_ARMED, AutoCaptureDecider.decide(ready.copy(armed = false)))
        assertEquals(AutoDecision.NO_DIRECTION, AutoCaptureDecider.decide(ready.copy(nearestKeptDeg = null)))
        assertEquals(AutoDecision.STORAGE_BLOCKED, AutoCaptureDecider.decide(ready.copy(storageBlocked = true)))
        assertEquals(AutoDecision.BUSY, AutoCaptureDecider.decide(ready.copy(busy = true)))
        assertEquals(AutoDecision.TOO_SOON, AutoCaptureDecider.decide(ready.copy(msSinceLastCapture = 100)))
        assertEquals(AutoDecision.TOO_CLOSE, AutoCaptureDecider.decide(ready.copy(nearestKeptDeg = 11.9)))
        assertEquals(AutoDecision.TOO_FAST, AutoCaptureDecider.decide(ready.copy(angularSpeedDegS = ViewSpacing.MAX_ANGULAR_SPEED_DEG_S + 1)))
        assertEquals(AutoDecision.TOO_FAST, AutoCaptureDecider.decide(ready.copy(linearSpeedMS = 1.0)))
        assertEquals(AutoDecision.POOR_QUALITY, AutoCaptureDecider.decide(ready.copy(liveFlags = listOf(FrameFlag.BLUR))))
        assertEquals(AutoDecision.POOR_QUALITY, AutoCaptureDecider.decide(ready.copy(liveFlags = listOf(FrameFlag.DARK))))
        assertEquals(AutoDecision.POOR_QUALITY, AutoCaptureDecider.decide(ready.copy(liveFlags = listOf(FrameFlag.OVEREXPOSED))))
    }

    @Test fun waitsInsteadOfGuessingWithoutEvidence() {
        assertFalse(AutoCaptureDecider.decide(ready.copy(liveFlags = null)).fire)
        assertFalse(AutoCaptureDecider.decide(ready.copy(angularSpeedDegS = null)).fire)
    }

    @Test fun onlyTheFireDecisionFires() {
        assertEquals(listOf(AutoDecision.FIRE), AutoDecision.entries.filter { it.fire })
    }

    // --- weak-frame classification -----------------------------------------------------------

    private val goodQuality = FrameQuality(sharpness = 400.0, clippedLow = 0.01, clippedHigh = 0.0, meanLuma = 120.0)

    @Test fun cleanFrameAtAGoodStepHasNoFlags() {
        val (q, flags) = FrameJudge.judge(goodQuality, emptyList(), ViewContext(nearestKeptDeg = 12.0, angularSpeedDegS = 3.0))
        assertTrue(flags.isEmpty())
        assertEquals(ViewSpacing.estimatedOverlap(12.0), q.overlap!!, 1e-12)
        assertEquals(400.0, q.sharpness!!, 0.0)
    }

    @Test fun firstFrameHasNoOverlapAndNoSpacingFlags() {
        val (q, flags) = FrameJudge.judge(goodQuality, emptyList(), ViewContext(nearestKeptDeg = Double.POSITIVE_INFINITY))
        assertTrue(flags.isEmpty())
        assertNull(q.overlap)
    }

    @Test fun imageFlagsAreKeptAndMotionFlagsAdded() {
        val (_, flags) = FrameJudge.judge(goodQuality, listOf(FrameFlag.BLUR, FrameFlag.DARK),
                                          ViewContext(nearestKeptDeg = 12.0, angularSpeedDegS = 60.0))
        assertEquals(listOf(FrameFlag.BLUR, FrameFlag.DARK, FrameFlag.FAST_MOTION), flags)
    }

    @Test fun fastTranslationIsFlaggedToo() {
        val (_, flags) = FrameJudge.judge(goodQuality, emptyList(), ViewContext(nearestKeptDeg = 12.0, angularSpeedDegS = 1.0, linearSpeedMS = 0.9))
        assertEquals(listOf(FrameFlag.FAST_MOTION), flags)
    }

    @Test fun trackingLostIsFlagged() {
        val (_, flags) = FrameJudge.judge(goodQuality, emptyList(), ViewContext(trackingLost = true))
        assertEquals(listOf(FrameFlag.TRACKING_LOST), flags)
    }

    @Test fun tooFarFromEveryKeptViewIsLowOverlap() {
        val (q, flags) = FrameJudge.judge(goodQuality, emptyList(), ViewContext(nearestKeptDeg = 38.0))
        assertEquals(listOf(FrameFlag.LOW_OVERLAP), flags)
        assertEquals(ViewSpacing.estimatedOverlap(38.0), q.overlap!!, 1e-12)
        assertTrue(FrameJudge.judge(goodQuality, emptyList(), ViewContext(nearestKeptDeg = 29.0)).second.isEmpty())
    }

    @Test fun sameDirectionAndSimilarImageIsADuplicate() {
        assertEquals(listOf(FrameFlag.DUPLICATE),
                     FrameJudge.judge(goodQuality, emptyList(), ViewContext(nearestKeptDeg = 1.5, hashDistanceToPrevious = 3)).second)
        // No hash available: the direction alone decides.
        assertEquals(listOf(FrameFlag.DUPLICATE),
                     FrameJudge.judge(goodQuality, emptyList(), ViewContext(nearestKeptDeg = 1.5)).second)
    }

    @Test fun sameDirectionButDifferentImageIsNotADuplicate() {
        // Static camera, changed content: left to the turntable detector, not called a duplicate.
        assertTrue(FrameJudge.judge(goodQuality, emptyList(), ViewContext(nearestKeptDeg = 1.5, hashDistanceToPrevious = 25)).second.isEmpty())
    }

    @Test fun withoutAnyDirectionOnlyAnAlmostIdenticalImageIsADuplicate() {
        assertEquals(listOf(FrameFlag.DUPLICATE),
                     FrameJudge.judge(goodQuality, emptyList(), ViewContext(hashDistanceToPrevious = 2)).second)
        assertTrue(FrameJudge.judge(goodQuality, emptyList(), ViewContext(hashDistanceToPrevious = 9)).second.isEmpty())
    }

    @Test fun liveWarningsAreSpecific() {
        val calm = ViewContext(nearestKeptDeg = 10.0, angularSpeedDegS = 5.0)
        assertTrue(FrameJudge.liveWarnings(emptyList(), calm, 5_000).isEmpty())
        assertEquals(listOf(LiveWarning.MOTION_BLUR_RISK),
                     FrameJudge.liveWarnings(emptyList(), calm.copy(angularSpeedDegS = 40.0), 5_000))
        // Blur while moving fast is reported once, as motion.
        assertEquals(listOf(LiveWarning.MOTION_BLUR_RISK),
                     FrameJudge.liveWarnings(listOf(FrameFlag.BLUR), calm.copy(angularSpeedDegS = 40.0), 5_000))
        assertEquals(listOf(LiveWarning.SOFT_IMAGE), FrameJudge.liveWarnings(listOf(FrameFlag.BLUR), calm, 5_000))
        assertEquals(listOf(LiveWarning.TOO_DARK, LiveWarning.OVEREXPOSED),
                     FrameJudge.liveWarnings(listOf(FrameFlag.DARK, FrameFlag.OVEREXPOSED), calm, 5_000))
        assertEquals(listOf(LiveWarning.LOW_OVERLAP), FrameJudge.liveWarnings(emptyList(), calm.copy(nearestKeptDeg = 45.0), 5_000))
    }

    @Test fun nearDuplicateHintWaitsAfterACapture() {
        val same = ViewContext(nearestKeptDeg = 1.0, angularSpeedDegS = 2.0)
        assertTrue(FrameJudge.liveWarnings(emptyList(), same, 300).isEmpty())
        assertEquals(listOf(LiveWarning.NEAR_DUPLICATE), FrameJudge.liveWarnings(emptyList(), same, 4_000))
    }

    @Test fun noSpacingWarningsWithoutADirectionOrWithoutPhotos() {
        assertTrue(FrameJudge.liveWarnings(null, ViewContext(), 9_000).isEmpty())
        assertTrue(FrameJudge.liveWarnings(null, ViewContext(nearestKeptDeg = Double.POSITIVE_INFINITY), 9_000).isEmpty())
    }

    // --- storage -------------------------------------------------------------------------------

    @Test fun storageThresholds() {
        val mb = 1024L * 1024
        assertEquals(StorageLevel.OK, StoragePolicy.level(500 * mb))
        assertEquals(StorageLevel.LOW, StoragePolicy.level(500 * mb - 1))
        assertEquals(StorageLevel.LOW, StoragePolicy.level(150 * mb))
        assertEquals(StorageLevel.BLOCKED, StoragePolicy.level(150 * mb - 1))
        assertEquals(StorageLevel.BLOCKED, StoragePolicy.level(0))
    }
}
