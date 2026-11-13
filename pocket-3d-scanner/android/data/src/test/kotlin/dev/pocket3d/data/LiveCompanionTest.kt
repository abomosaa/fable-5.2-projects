package dev.pocket3d.data

import dev.pocket3d.core.mesh.GlbReader
import dev.pocket3d.core.mesh.MeshOps
import dev.pocket3d.core.net.PairingInfo
import dev.pocket3d.core.net.ProtocolJson
import dev.pocket3d.core.project.CamerasDocument
import dev.pocket3d.core.project.CaptureSource
import dev.pocket3d.core.project.DeviceInfo
import dev.pocket3d.core.project.Frame
import dev.pocket3d.core.project.JobPhase
import dev.pocket3d.core.services.PairResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * The phone's real data layer (pinned-TLS client, pairing, store, sync engine) against a REAL
 * running companion doing a REAL reconstruction of real photographs — no fakes on either side.
 *
 * Skipped unless `POCKET3D_TEST_PAIRING_FILE` points at the companion's `pairing.txt`:
 *
 *     POCKET3D_TEST_PAIRING_FILE=$PWD/.work/companion-data/pairing.txt \
 *       ./gradlew :data:cleanTestDebugUnitTest :data:testDebugUnitTest --tests '*LiveCompanionTest*'
 *
 * Optional: POCKET3D_TEST_HOST (default 127.0.0.1), POCKET3D_TEST_IMAGES (default datasets/smoke/images).
 */
class LiveCompanionTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun pairUploadReconstructDownloadVerifyAgainstTheRealCompanion() = runBlocking {
        val pairingFile = System.getenv("POCKET3D_TEST_PAIRING_FILE")
        assumeTrue("POCKET3D_TEST_PAIRING_FILE not set — live companion test skipped", !pairingFile.isNullOrBlank())
        val uri = File(pairingFile!!).readLines().first().trim()
        val parsed = PairingInfo.parse(uri) ?: throw AssertionError("pairing.txt does not contain a pairing URI")
        val info = parsed.copy(hosts = listOf(System.getenv("POCKET3D_TEST_HOST") ?: "127.0.0.1"))
        val images = File(System.getenv("POCKET3D_TEST_IMAGES") ?: "../../datasets/smoke/images")
            .listFiles { f -> f.extension.lowercase() in setOf("jpg", "jpeg") }!!.sortedBy { it.name }
        assertTrue("need the smoke photos", images.size >= 8)

        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val link = CompanionLinkImpl(InMemoryPairingStore(), CompanionApiFactory { url, fp, token, _ -> CompanionClient(url, fp, token) })
            // a wrong fingerprint must be refused before any pairing code is sent
            val forged = info.copy(fingerprintSha256 = "0".repeat(64))
            assertTrue(link.pair(forged, "jvm live test") is PairResult.Failure)
            val paired = link.pair(info, "jvm live test")
            assertTrue("pairing failed: $paired", paired is PairResult.Success)
            link.refresh()
            val st = link.state.value
            assertTrue(st.paired && st.reachable == true)
            assertNotNull(st.status)
            assertEquals(null, st.status!!.hardware.gpu)            // CPU reconstruction, reported honestly

            val store = FileProjectStore(tmp.root)
            val engine = SyncEngine(store, link, scope)
            val project = store.createProject("Live smoke")
            val session = store.createSession(project.id, CaptureSource.IMPORT, DeviceInfo("test", "jvm", 0))
            val ids = images.mapIndexed { i, f ->
                val t = store.newFrameTempFile(project.id, session.id)
                f.copyTo(t, overwrite = true)
                store.commitFrame(project.id, session.id,
                    Frame(id = "%04d".format(i + 1), name = f.name, file = "", width = 1200, height = 800, format = "jpeg"), t).id
            }
            val job = engine.startJob(project.id, session.id, "preview", ids)
            val seen = LinkedHashSet<String>()
            var sawPreviewWhileRunning = false
            val done = withTimeout(15 * 60_000L) {
                while (true) {
                    val j = store.job(project.id, job.id)!!
                    j.stage?.let { if (j.phase == JobPhase.RUNNING) seen += it }
                    if (j.phase == JobPhase.RUNNING && j.hasSparsePreview) sawPreviewWhileRunning = true
                    if (j.phase.isTerminal) return@withTimeout j
                    delay(100)
                }
                @Suppress("UNREACHABLE_CODE") error("unreachable")
            }
            assertEquals("job ended as ${done.phase}: ${done.error}", JobPhase.COMPLETED, done.phase)
            println("LIVE stages seen while running: $seen; sparse preview while running: $sawPreviewWhileRunning")
            assertTrue("real stage names were reported: $seen", seen.any { it in setOf("features", "matching", "sfm", "dense", "mesh", "texture") })
            assertEquals(images.sumOf { it.length() }, done.uploadedBytes)

            // the downloaded model is a real, loadable textured mesh
            val model = store.model(project.id, done.modelId!!)!!
            assertEquals(done.modelId, store.project(project.id)!!.activeModelId)
            val dir = store.modelDir(project.id, model.id)
            val glbFile = File(dir, "model.glb")
            assertEquals(StorageFiles.sha256(glbFile).sha256, model.glbSha256)
            val doc = GlbReader.read(glbFile)
            val mesh = doc.mesh
            assertTrue("faces=${mesh.faceCount}", mesh.faceCount > 5000)
            assertEquals(model.faceCount, mesh.faceCount)
            assertNotNull(mesh.uvs); assertNotNull(mesh.confidence)
            assertTrue(mesh.materials.any { it.baseColorTexture != null })
            assertTrue(MeshOps.surfaceArea(mesh) > 0f)
            assertTrue(MeshOps.findHoles(mesh).isNotEmpty())             // an open scan: holes are preserved, not filled
            assertEquals("arbitrary", model.reconstructionScale.units)  // photos alone give no size
            assertTrue(model.registeredCameras in 6..12 && model.inputFrames == 12)
            val cams = ProtocolJson.decodeFromString(CamerasDocument.serializer(), File(dir, "cameras.json").readText())
            assertEquals(model.registeredCameras, cams.cameras.size)
            assertEquals(12, cams.cameras.size + cams.unregistered.size)
            assertTrue(cams.cameras.all { c -> ids.contains(c.id) })      // cameras map back to the phone's frame ids
            assertTrue(File(store.jobDir(project.id, job.id), "sparse_preview.json").length() > 1000)
            println("LIVE model: ${mesh.faceCount} faces, ${model.registeredCameras}/${model.inputFrames} cameras, glb ${glbFile.length()} bytes")

            // deleting the companion's copies works and is reported per session
            assertEquals(listOf(session.id), link.deleteRemoteSessions(listOf(session.id)))
            // asking again is harmless: "no copy remains" is reported for it either way
            assertEquals(listOf(session.id), link.deleteRemoteSessions(listOf(session.id)))
            link.unpair()
            assertTrue(!link.state.value.paired)
        } finally {
            scope.cancel()
        }
    }
}
