package dev.pocket3d.app

import android.util.Log
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollToNodeAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.pocket3d.core.services.Services
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumented UI tests of the real app (real storage, real navigation) on a device/emulator.
 * They create their own uniquely named project and remove it again; existing projects and the
 * companion pairing are not touched.
 *
 *   ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest
 *   adb install -r app/build/outputs/apk/debug/app-debug.apk
 *   adb install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
 *   adb shell am instrument -w dev.pocket3d.app.test/androidx.test.runner.AndroidJUnitRunner
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class AppFlowTest {
    @get:Rule val rule = createAndroidComposeRule<MainActivity>()
    private val name = "UITest-" + System.currentTimeMillis() % 100000

    @After fun cleanUp() = runBlocking {
        Services.store.summaries.value.filter { it.project.name.startsWith("UITest-") }
            .forEach { Services.store.deleteProject(it.project.id) }
    }

    /**
     * If a test fails while a screen is mid-transition, tearing the activity down can crash the
     * process and hide the assertion that actually failed; log it first (`adb logcat -s UITEST`).
     */
    private fun logged(body: () -> Unit) = try { body() } catch (t: Throwable) { Log.e("UITEST", "test failed", t); throw t }

    /** Lazy lists compose only what is visible: scroll the list until the item exists. */
    private fun scrollTo(text: String) {
        rule.onNode(hasScrollToNodeAction()).performScrollToNode(hasText(text, substring = true))
    }

    private fun waitForText(text: String, timeoutMs: Long = 8000) =
        rule.waitUntilAtLeastOneExists(hasText(text, substring = true), timeoutMs)

    @Test fun newProjectLeadsToTheCaptureGuideAndCannotReconstructWithoutPhotos() = logged {
        rule.onNodeWithText("New scan", useUnmergedTree = true).performClick()
        rule.onNode(hasSetTextAction()).performTextInput(name)
        rule.onNodeWithText("Create").performClick()
        // the capture guide states the one rule and the limits before any photo is taken
        waitForText("The object stays still. You move around it.")
        rule.onNodeWithText("Import photos").assertIsDisplayed()
        rule.onNodeWithText("Start capture").assertIsDisplayed()
        rule.onNodeWithContentDescription("Back").performClick()
        // project screen: where things run is stated; nothing can be reconstructed yet
        waitForText("No photos yet")
        scrollTo("Runs on companion computer"); rule.onNodeWithText("Runs on companion computer", substring = true).assertIsDisplayed()
        scrollTo("Add photos first"); rule.onNodeWithText("Add photos first").assertIsNotEnabled()
        scrollTo("No model yet."); rule.onNodeWithText("No model yet.", substring = true).assertIsDisplayed()
        val p = Services.store.summaries.value.single { it.project.name == name }
        assertEquals(0, p.frameCount); assertTrue(!p.hasModel); assertEquals(null, p.thumbnailPath)
    }

    @Test fun deleteDialogSaysExactlyWhatIsRemoved() = logged {
        runBlocking { Services.store.createProject(name) }
        waitForText(name)
        rule.onNodeWithContentDescription("Project actions for $name").performClick()
        rule.onNodeWithText("Delete…").performClick()
        waitForText("This permanently removes from this phone:")
        rule.onNodeWithText("0 source photos", substring = true).assertIsDisplayed()
        rule.onNodeWithText("No copies of these photos are known to be on a paired companion.", substring = true).assertIsDisplayed()
        rule.onNodeWithText("Cancel").performClick()
        assertTrue(Services.store.summaries.value.any { it.project.name == name })     // cancel really cancels
        rule.onNodeWithContentDescription("Project actions for $name").performClick()
        rule.onNodeWithText("Delete…").performClick()
        waitForText("This permanently removes from this phone:")
        rule.onNodeWithText("Delete").performClick()
        rule.waitUntil(8000) { Services.store.summaries.value.none { it.project.name == name } }
        rule.waitUntil(8000) { rule.onAllNodesWithText(name).fetchSemanticsNodes().isEmpty() }
    }

    @Test fun pairingScreenValidatesTheLinkAndShowsTheFingerprintBeforeAnythingIsSent() = logged {
        rule.onNode(hasContentDescription("Open companion settings", substring = true)).performClick()
        waitForText("runs on a computer you control", 8000)
        val field = rule.onNode(hasSetTextAction())
        field.performScrollTo()
        field.performTextInput("https://example.com/not-a-pairing-link")
        waitForText("This is not a valid pairing link.")
        rule.onNodeWithText("Pair").performScrollTo().assertIsNotEnabled()
        rule.activityRule.scenario.onActivity { }      // keep the activity; replace the text with a well-formed link
        field.performTextInput("")
        rule.onNodeWithContentDescription("Back").performClick()
        rule.onNode(hasContentDescription("Open companion settings", substring = true)).performClick()
        val fp = "ab".repeat(32)
        rule.onNode(hasSetTextAction()).performScrollTo()
        rule.onNode(hasSetTextAction()).performTextInput("pocket3d://pair?v=1&host=192.0.2.7&port=8443&fp=$fp&code=ABCD2345")
        waitForText("Certificate fingerprint (must match the companion’s terminal):")
        rule.onNodeWithText(fp.chunked(4).joinToString(" ")).performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("192.0.2.7:8443", substring = true).assertExists()
    }

    @Test fun settingsStateWhatRunsWhereAndReportThisDevice() = logged {
        rule.onNodeWithContentDescription("Settings and device capabilities").performClick()
        waitForText("WHAT RUNS WHERE")
        rule.onNodeWithText("Dense depth maps, fusion (OpenMVS)").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("Camera poses, bundle adjustment (COLMAP)").performScrollTo().assertIsDisplayed()
        assertTrue(rule.onAllNodesWithText("Companion").fetchSemanticsNodes().size >= 4)
        assertTrue(rule.onAllNodesWithText("Phone").fetchSemanticsNodes().size >= 6)
        rule.waitUntilAtLeastOneExists(hasText("AR motion tracking (ARCore)"), 15000)     // real capability probe finished
        rule.onNodeWithText("ARCore depth").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("Photos alone give shape but not size.", substring = true).performScrollTo().assertIsDisplayed()
    }

    @Test fun existingModelOpensInTheViewerWithAnHonestScaleStatement() = logged {
        val withModel = Services.store.summaries.value.firstOrNull { it.hasModel && !it.project.name.startsWith("UITest-") }
        assumeTrue("no reconstructed project on this device — viewer test skipped", withModel != null)
        rule.onNodeWithText(withModel!!.project.name).performClick()
        waitForText("PHOTOS (ON THIS PHONE)")
        val model = runBlocking { Services.store.models(withModel.project.id).first() }
        scrollTo("triangles")
        rule.onAllNodesWithText("triangles", substring = true)[0].performClick()
        // wait for the viewer itself (the project screen also carries a scale line)
        rule.waitUntilAtLeastOneExists(hasText("Measure"), 30_000)
        // the viewer always shows one of the three scale statements — never a bare number
        rule.waitUntil(30_000) {
            listOf("Uncalibrated — arbitrary units", "Calibrated from reference", "AR-estimated scale")
                .any { rule.onAllNodesWithText(it, substring = true).fetchSemanticsNodes().isNotEmpty() }
        }
        rule.onNodeWithText("Export").performClick()
        waitForText("Save to…")
        if (!model.reconstructionScale.isMetric && rule.onAllNodesWithText("Uncalibrated — arbitrary units").fetchSemanticsNodes().isNotEmpty()) {
            rule.onNodeWithText("No real-world scale", substring = true).assertExists()
        }
    }
}
