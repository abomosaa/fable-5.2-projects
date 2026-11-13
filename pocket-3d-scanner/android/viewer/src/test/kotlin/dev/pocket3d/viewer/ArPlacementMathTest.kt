package dev.pocket3d.viewer

import dev.pocket3d.core.math.Mat4
import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.mesh.Aabb
import dev.pocket3d.core.scale.ScaleCalibration
import dev.pocket3d.design.Tone
import dev.pocket3d.viewer.ar.ArPlacementMath
import dev.pocket3d.viewer.ar.ArSizing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ArPlacementMathTest {
    private val user = ScaleCalibration(0.2, 0.013, ScaleCalibration.Source.USER_REFERENCE)
    private val ar = ScaleCalibration(1.0, 0.05, ScaleCalibration.Source.AR_TRACKING)

    @Test fun calibratedModelIsTrueSizeAndPinchIsLocked() {
        val s = ArSizing(user, longestSideUnits = 1.5f)
        assertEquals("True size (calibrated ±1.3%)", s.label().text)
        assertEquals(Tone.Good, s.label().tone)
        assertEquals(0.2f, s.metersPerUnit!!, 1e-7f)
        assertEquals(0.3f, s.shownLongestMeters!!, 1e-6f)
        assertTrue(s.canPlace)
        assertFalse(s.pinchScales)
        assertEquals(s, s.pinch(1.8f))                      // locked: pinching changes nothing
        assertEquals(s, s.withManualLongest(3f))            // a manual size cannot override a real scale
    }

    @Test fun arEstimatedScaleIsLabelledAsEstimate() {
        val l = ArSizing(ar, 1f).label()
        assertEquals("AR-estimated size ±5.0%", l.text)
        assertEquals(Tone.Provisional, l.tone)
    }

    @Test fun unlockedScaleIsLabelledNotToScale() {
        var s = ArSizing(user, 1.5f).unlock(true)
        assertTrue(s.pinchScales)
        assertEquals("True size (calibrated ±1.3%)", s.label().text)     // unlocked but untouched is still true size
        s = s.pinch(1.37f)
        assertEquals("Not to scale ×1.37", s.label().text)
        assertEquals(Tone.Warn, s.label().tone)
        assertEquals(0.2f * 1.37f, s.metersPerUnit!!, 1e-6f)
        s = s.pinch(1000f)
        assertEquals(ArSizing.MAX_FACTOR, s.userFactor, 0f)
        assertEquals(s, s.pinch(Float.NaN)); assertEquals(s, s.pinch(0f))
        // locking again returns to true size
        val locked = s.unlock(false)
        assertEquals(1f, locked.userFactor, 0f)
        assertEquals("True size (calibrated ±1.3%)", locked.label().text)
        assertEquals(0.2f, locked.metersPerUnit!!, 1e-7f)
    }

    @Test fun uncalibratedModelNeedsAnExplicitSize() {
        var s = ArSizing(null, longestSideUnits = 0.8f)
        // nothing is invented: no size, no placement
        assertNull(s.metersPerUnit); assertFalse(s.canPlace); assertFalse(s.pinchScales)
        assertEquals("Size not set", s.label().text)
        assertEquals(s, s.pinch(2f))
        assertEquals(s, s.unlock(true).copy(scaleUnlocked = false))
        s = s.withManualLongest(0.24f)
        assertTrue(s.canPlace)
        assertEquals("Longest side ≈ 24 cm (manual — not measured)", s.label().text)
        assertEquals(Tone.Warn, s.label().tone)
        assertEquals(0.3f, s.metersPerUnit!!, 1e-6f)
        assertEquals(0.24f, s.shownLongestMeters!!, 1e-6f)
        s = s.pinch(2f)
        assertEquals("Longest side ≈ 48 cm (manual — not measured)", s.label().text)
        assertEquals(ArSizing.MAX_MANUAL_METERS, s.pinch(1e6f).manualLongestMeters!!, 0f)
        assertEquals(ArSizing.MIN_MANUAL_METERS, s.pinch(1e-6f).manualLongestMeters!!, 0f)
        assertTrue(s.withManualLongest(1.5f).label().text.startsWith("Longest side ≈ 1.5 m"))
        // slider mapping is monotonic and invertible
        assertEquals(ArSizing.MIN_MANUAL_METERS, ArSizing.manualFromSlider(0f), 1e-6f)
        assertEquals(ArSizing.MAX_MANUAL_METERS, ArSizing.manualFromSlider(1f), 1e-4f)
        for (v in listOf(0.1f, 0.5f, 0.9f)) assertEquals(v, ArSizing.sliderFromManual(ArSizing.manualFromSlider(v)), 1e-4f)
    }

    @Test fun lowestPointOfTheEditedMeshSitsOnTheAnchor() {
        // bounds far from the model origin, as after cropping
        val b = Aabb(Vec3(2f, -0.7f, -3f), Vec3(4f, 1.3f, -1f))
        assertEquals(Vec3(3f, -0.7f, -2f), ArPlacementMath.contactPoint(b))
        for (yaw in listOf(0f, 0.9f, -2.5f)) {
            val m = ArPlacementMath.localMatrix(b, 0.25f, yaw)
            // the contact point maps to the anchor origin
            assertTrue(Mat4.transformPoint(m, ArPlacementMath.contactPoint(b)).length() < 1e-5f)
            var minY = Float.MAX_VALUE; var maxY = -Float.MAX_VALUE
            for (i in 0 until 8) {
                val c = Vec3(if (i and 1 == 0) b.min.x else b.max.x, if (i and 2 == 0) b.min.y else b.max.y, if (i and 4 == 0) b.min.z else b.max.z)
                val p = Mat4.transformPoint(m, c)
                minY = minOf(minY, p.y); maxY = maxOf(maxY, p.y)
                // horizontally centred on the anchor: corners are within the scaled half diagonal
                assertTrue(kotlin.math.hypot(p.x, p.z) <= 0.25f * kotlin.math.hypot(1f, 1f) + 1e-4f)
            }
            assertEquals("nothing below the plane", 0f, minY, 1e-5f)
            assertEquals("height scaled to metres", 2f * 0.25f, maxY, 1e-5f)
            // rigid + uniform scale only: model up stays the plane normal, lengths scale by metres per unit
            val up = Mat4.transformDir(m, Vec3.Y)
            assertEquals(0.25f, up.y, 1e-6f); assertEquals(0f, up.x, 1e-6f); assertEquals(0f, up.z, 1e-6f)
            assertEquals(0.25f, Mat4.transformDir(m, Vec3.X).length(), 1e-6f)
        }
        assertEquals(0.25f, ArPlacementMath.footprintRadius(b, 0.25f), 1e-6f)
    }

    @Test fun exposureAdjustmentIsGentle() {
        assertEquals(1f, ArPlacementMath.exposure(0.5f), 1e-6f)
        assertTrue(ArPlacementMath.exposure(0f) >= 0.75f)
        assertTrue(ArPlacementMath.exposure(1f) <= 1.15f)
        assertTrue(ArPlacementMath.exposure(0.2f) < ArPlacementMath.exposure(0.8f))
        assertEquals(ArPlacementMath.exposure(1f), ArPlacementMath.exposure(7f), 0f)
    }
}
