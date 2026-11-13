package dev.pocket3d.core.scale

import dev.pocket3d.core.math.Vec3
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.sqrt

class ScaleTest {
    private val a = Vec3(0f, 0f, 0f)
    private val b = Vec3(0.8f, 0f, 0f)       // 0.8 model units apart

    @Test fun referenceCalibrationGivesMetersPerUnitAndCombinedUncertainty() {
        // 0.8 units == 200 mm, known to ±1 mm, picked to ±0.004 units per endpoint
        val c = ScaleCalibration.fromReference(a, b, 0.200, 0.001, 0.004)!!
        assertEquals(0.25, c.metersPerUnit, 1e-6)
        val expected = sqrt((0.001 / 0.2) * (0.001 / 0.2) + 2 * (0.004 / 0.8) * (0.004 / 0.8) +
                            ScaleCalibration.SHAPE_UNCERTAINTY * ScaleCalibration.SHAPE_UNCERTAINTY)
        assertEquals(expected, c.relativeUncertainty, 1e-7)
        assertEquals(ScaleCalibration.Source.USER_REFERENCE, c.source)
        assertEquals(0.200, c.refDistanceMeters!!, 0.0)
    }

    @Test fun rejectsMeaninglessReferences() {
        assertNull(ScaleCalibration.fromReference(a, a, 0.2, 0.001, 0.004))          // zero length
        assertNull(ScaleCalibration.fromReference(a, b, 0.0, 0.001, 0.004))          // zero real distance
        assertNull(ScaleCalibration.fromReference(a, b, -1.0, 0.001, 0.004))
        assertNull(ScaleCalibration.fromReference(a, b, Double.POSITIVE_INFINITY, 0.001, 0.004))
        assertNull(ScaleCalibration.fromReference(a, b, Double.NaN, 0.001, 0.004))
        assertNull(ScaleCalibration.fromReference(a, b, 0.2, 0.001, 0.3))            // shorter than 4x picking noise
        assertNull(ScaleCalibration.fromReference(a, b, 0.2, -0.001, 0.004))
    }

    @Test fun uncalibratedLengthsAreNeverPresentedAsMeasurements() {
        val l = Measure.length(a, b, null, 0.004)
        assertFalse(l.metric)
        val text = l.format()
        assertTrue(text, text.contains("uncalibrated"))
        assertFalse(text, text.contains(" m") && !text.contains("units"))
        assertFalse(text.contains("cm") || text.contains("mm"))
    }

    @Test fun measuredLengthCarriesScaleAndPickingUncertainty() {
        val c = ScaleCalibration.fromReference(a, b, 0.200, 0.001, 0.004)!!
        val p = Vec3(0f, 0f, 0f); val q = Vec3(0f, 0.4f, 0f)     // 0.4 units = 100 mm
        val l = Measure.length(p, q, c, 0.004)
        assertTrue(l.metric)
        assertEquals(0.100, l.value, 1e-6)
        val pick = sqrt(2.0) * 0.004 * 0.25
        val expected = sqrt((0.1 * c.relativeUncertainty) * (0.1 * c.relativeUncertainty) + pick * pick)
        assertEquals(expected, l.sigma, 1e-7)
        assertTrue(l.sigma > 0.001)         // the result is honest about being worse than ±1 mm
    }

    @Test fun formattingNeverShowsMoreDigitsThanTheUncertaintySupports() {
        assertEquals("10.0 ± 0.2 cm", Length(0.1000, 0.0016, true).format())
        assertEquals("1.23 ± 0.02 m", Length(1.2345, 0.012, true).format())
        assertEquals("12 ± 3 cm", Length(0.1234, 0.021, true).format())
        assertEquals("4.5 ± 0.3 mm", Length(0.00451, 0.00021, true).format())
        // uncertainty is rounded UP, never down
        assertEquals("10.0 ± 0.2 cm", Length(0.1000, 0.00101, true).format())
        // every metric string carries the ± term
        for (v in listOf(0.004, 0.05, 0.31, 2.7)) assertTrue(Length(v, v * 0.03, true).format().contains("±"))
    }

    @Test fun longerReferenceGivesTighterScale() {
        val short = ScaleCalibration.fromReference(a, Vec3(0.1f, 0f, 0f), 0.025, 0.001, 0.004)
        val long = ScaleCalibration.fromReference(a, b, 0.200, 0.001, 0.004)
        assertNotNull(short); assertNotNull(long)
        assertTrue(short!!.relativeUncertainty > 2.5 * long!!.relativeUncertainty)
    }

    @Test fun noCalibrationClaimsToBeBetterThanTheShapeAccuracyOfPhotogrammetry() {
        // a perfect ruler and a perfect pick still leave the reconstruction's own shape error
        val perfect = ScaleCalibration.fromReference(a, Vec3(100f, 0f, 0f), 1.0, 0.0, 0.0)!!
        assertEquals(ScaleCalibration.SHAPE_UNCERTAINTY, perfect.relativeUncertainty, 1e-12)
        val l = Measure.length(a, Vec3(50f, 0f, 0f), perfect, 0.0)
        assertEquals(0.5, l.value, 1e-9)
        assertEquals(0.5 * ScaleCalibration.SHAPE_UNCERTAINTY, l.sigma, 1e-9)
        assertTrue(l.format().contains("±"))
    }

    @Test fun formattingDoesNotDependOnTheDeviceLocale() {
        val before = java.util.Locale.getDefault()
        try {
            for (tag in listOf("de-DE", "ar-EG", "fr-FR")) {
                java.util.Locale.setDefault(java.util.Locale.forLanguageTag(tag))
                assertEquals("10.0 ± 0.2 cm", Length(0.1000, 0.0016, true).format())
                assertEquals("0.353 units (uncalibrated)", Length(0.353, 0.004, false).format())
            }
        } finally {
            java.util.Locale.setDefault(before)
        }
    }
}
