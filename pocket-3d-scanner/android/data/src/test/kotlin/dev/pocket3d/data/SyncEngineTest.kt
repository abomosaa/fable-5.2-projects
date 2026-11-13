package dev.pocket3d.data

import dev.pocket3d.core.net.JobError
import dev.pocket3d.core.net.RemoteState
import dev.pocket3d.core.project.CaptureSource
import dev.pocket3d.core.project.DeviceInfo
import dev.pocket3d.core.project.JobPhase
import dev.pocket3d.core.project.ReconJob
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * Job supervision against a scripted companion ([FakeCompanion] keeps sessions, upload offsets
 * and jobs like the real server). Every test uses the real [FileProjectStore] on disk, so
 * "restart" means: cancel the engine's scope and build a new store + engine on the same folder.
 */
class SyncEngineTest {
    @get:Rule val tmp = TemporaryFolder()
    private val scopes = ArrayList<CoroutineScope>()
    private val fast = SyncConfig(backoffInitialMs = 20, backoffMaxMs = 80, pollWaitSeconds = 1, minPollIntervalMs = 5,
                                  progressIntervalMs = 5)

    @After fun tearDown() { scopes.forEach { it.cancel() } }

    private class World(val store: FileProjectStore, val engine: SyncEngine, val gateway: FakeGateway, val scope: CoroutineScope)

    private fun world(companion: FakeCompanion?, root: File = tmp.root): World {
        val store = FileProjectStore(root)
        val gateway = FakeGateway(companion?.paired())
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
        return World(store, SyncEngine(store, gateway, scope, config = fast), gateway, scope)
    }

    private suspend fun World.projectWithPhotos(n: Int = 3, bytesEach: Int = 4000): Triple<String, String, List<String>> {
        val p = store.createProject("p")
        val s = store.createSession(p.id, CaptureSource.IMPORT, DeviceInfo())
        val ids = (1..n).map { i -> store.addFrame(p.id, s.id, "f$i", randomBytes(bytesEach, i.toLong())).id }
        return Triple(p.id, s.id, ids)
    }

    private suspend fun World.await(pid: String, jid: String, timeoutMs: Long = 10_000, what: String = "",
                                    cond: (ReconJob) -> Boolean): ReconJob = try {
        withTimeout(timeoutMs) {
            while (true) {
                val j = store.job(pid, jid)
                if (j != null && cond(j)) return@withTimeout j
                delay(5)
            }
            @Suppress("UNREACHABLE_CODE") error("unreachable")
        }
    } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
        throw AssertionError("timed out waiting for $what; job is ${store.job(pid, jid)}")
    }

    // ------------------------------------------------------------------------------------------

    @Test fun happyPathGoesThroughEveryPhaseAndRegistersTheModelOnlyAfterVerification() = runBlocking {
        val companion = FakeCompanion()
        val w = world(companion)
        val (pid, sid, ids) = w.projectWithPhotos()
        val phases = ArrayList<JobPhase>()
        val job = w.engine.startJob(pid, sid, "standard", ids)
        assertEquals(JobPhase.PENDING, job.phase)
        assertNull(w.store.project(pid)!!.activeModelId)
        val done = w.await(pid, job.id, what = "completion") { phases += it.phase; it.phase.isTerminal }
        assertEquals(JobPhase.COMPLETED, done.phase)
        // phases only ever moved forward
        val order = listOf(JobPhase.PENDING, JobPhase.UPLOADING, JobPhase.QUEUED, JobPhase.RUNNING, JobPhase.DOWNLOADING, JobPhase.COMPLETED)
        assertEquals(phases.map { order.indexOf(it) }, phases.map { order.indexOf(it) }.sorted())
        assertEquals(12_000L, done.uploadedBytes); assertEquals(12_000L, done.totalBytes)
        assertEquals(companion.serverId, done.companionId)
        assertTrue(done.hasSparsePreview)
        assertTrue(File(w.store.jobDir(pid, job.id), "sparse_preview.json").isFile)
        assertNull(done.error); assertNull(done.waitingReason)
        // the model exists, is active, and its bytes are exactly what the companion published
        val model = w.store.model(pid, done.modelId!!)!!
        assertEquals(done.modelId, w.store.project(pid)!!.activeModelId)
        val glb = File(w.store.modelDir(pid, model.id), "model.glb").readBytes()
        assertTrue(glb.contentEquals(companion.artifactBytes.getValue("model.glb")))
        assertEquals(StorageFiles.sha256(glb), model.glbSha256)
        assertEquals(2345, model.faceCount); assertEquals(1234, model.vertexCount)
        assertEquals(3, model.registeredCameras); assertEquals("arbitrary", model.reconstructionScale.units)
        // nothing was done twice
        assertEquals(1, companion.submitCount)
        assertEquals(12_000L, companion.bytesSent.values.sum())
        assertEquals(listOf("cameras.json", "diagnostics.json", "model.glb", "sparse_preview.json"), companion.downloads.sorted())
        // the uploaded manifest covers exactly the selected frames, with capture metadata
        val manifest = companion.sessions.getValue(sid).manifest
        assertEquals(ids, manifest.files.map { it.id })
    }

    @Test fun onlySelectedFramesAreUploaded() = runBlocking {
        val companion = FakeCompanion()
        val w = world(companion)
        val (pid, sid, ids) = w.projectWithPhotos(4)
        val job = w.engine.startJob(pid, sid, "preview", listOf(ids[0], ids[2], ids[3]))
        w.await(pid, job.id, what = "completion") { it.phase == JobPhase.COMPLETED }
        assertEquals(setOf(ids[0], ids[2], ids[3]), companion.sessions.getValue(sid).files.keys)
        assertEquals(12_000L, companion.bytesSent.values.sum())
    }

    @Test fun unreachableCompanionNeverFailsTheJobAndRecovers() = runBlocking {
        val companion = FakeCompanion().apply { unreachable = true }
        val w = world(companion)
        val (pid, sid, ids) = w.projectWithPhotos()
        val job = w.engine.startJob(pid, sid, "standard", ids)
        val waiting = w.await(pid, job.id, what = "waiting reason") { it.waitingReason != null }
        assertTrue(waiting.phase.isActive)
        assertTrue(waiting.waitingReason!!.contains("unreachable", ignoreCase = true))
        delay(300)                                              // many back-off rounds later…
        assertTrue(w.store.job(pid, job.id)!!.phase.isActive)   // …still not failed
        assertTrue(w.gateway.probes > 0)
        companion.unreachable = false
        w.engine.wake()
        val done = w.await(pid, job.id, what = "completion after recovery") { it.phase.isTerminal }
        assertEquals(JobPhase.COMPLETED, done.phase)
        assertNull(done.waitingReason)
    }

    @Test fun connectionLossWhileRunningKeepsThePhaseAndContinuesFromLastEvent() = runBlocking {
        val companion = FakeCompanion()
        companion.scriptFor = { companion.runningScript(6, companion.successScript().takeLast(1)) }
        var polls = 0
        companion.pollHook = { if (++polls in 3..5) throw CompanionException.unreachable("down") }
        val w = world(companion)
        val (pid, sid, ids) = w.projectWithPhotos()
        val job = w.engine.startJob(pid, sid, "standard", ids)
        w.await(pid, job.id, what = "running + waiting") { it.phase == JobPhase.RUNNING && it.waitingReason != null }
        val done = w.await(pid, job.id, what = "completion") { it.phase.isTerminal }
        assertEquals(JobPhase.COMPLETED, done.phase)
        // event sequence numbers requested from the companion never went backwards
        assertEquals(companion.pollSince, companion.pollSince.sorted())
        assertEquals(1, companion.submitCount)
    }

    @Test fun remoteFailureCopiesDiagnosisAndGuidanceAndKeepsThePreviousModel() = runBlocking {
        val companion = FakeCompanion()
        val w = world(companion)
        val (pid, sid, ids) = w.projectWithPhotos()
        val first = w.engine.startJob(pid, sid, "preview", ids)
        val ok = w.await(pid, first.id, what = "first model") { it.phase == JobPhase.COMPLETED }
        val goodModel = ok.modelId!!
        val goodBytes = File(w.store.modelDir(pid, goodModel), "model.glb").readBytes()

        val error = JobError("insufficient_registration", "Only 2 of 3 photographs could be registered.",
                             listOf("Take more photos with more overlap."))
        companion.scriptFor = { companion.failScript(error) }
        val second = w.engine.startJob(pid, sid, "high", ids)
        val failed = w.await(pid, second.id, what = "failure") { it.phase.isTerminal }
        assertEquals(JobPhase.FAILED, failed.phase)
        assertEquals(error, failed.error)
        assertNull(failed.modelId)
        // re-running with other settings did not touch the good result
        assertEquals(goodModel, w.store.project(pid)!!.activeModelId)
        assertEquals(listOf(goodModel), w.store.models(pid).map { it.id })
        assertTrue(File(w.store.modelDir(pid, goodModel), "model.glb").readBytes().contentEquals(goodBytes))
    }

    @Test fun cancelDuringUploadStopsUploadingAndTellsTheCompanion() = runBlocking {
        val companion = FakeCompanion().apply { uploadChunkBytes = 500 }
        val gate = CompletableDeferred<Unit>()
        companion.uploadHook = { _, received -> if (received >= 1000) gate.await() }
        val w = world(companion)
        val (pid, sid, ids) = w.projectWithPhotos()
        val job = w.engine.startJob(pid, sid, "standard", ids)
        w.await(pid, job.id, what = "uploading") { it.phase == JobPhase.UPLOADING }
        w.engine.cancelJob(pid, job.id)
        val cancelled = w.store.job(pid, job.id)!!
        assertEquals(JobPhase.CANCELLED, cancelled.phase)          // immediate, not after the network answers
        gate.complete(Unit)
        delay(200)
        assertEquals(JobPhase.CANCELLED, w.store.job(pid, job.id)!!.phase)
        assertEquals(0, companion.submitCount)                     // never submitted
        assertTrue(companion.bytesSent.values.sum() < 12_000L)
        assertNull(w.store.project(pid)!!.activeModelId)
    }

    @Test fun cancelWhileRunningIsDeliveredEvenIfTheCompanionWasUnreachableAtThatMoment() = runBlocking {
        val companion = FakeCompanion()
        companion.scriptFor = { companion.runningScript(10_000) }
        val w = world(companion)
        val (pid, sid, ids) = w.projectWithPhotos()
        val job = w.engine.startJob(pid, sid, "standard", ids)
        w.await(pid, job.id, what = "running") { it.phase == JobPhase.RUNNING }
        companion.unreachable = true
        w.engine.cancelJob(pid, job.id)
        assertEquals(JobPhase.CANCELLED, w.store.job(pid, job.id)!!.phase)
        delay(150)
        assertEquals(0, companion.cancelCount)
        companion.unreachable = false
        w.engine.wake()
        withTimeout(5000) { while (companion.cancelCount == 0) delay(10) }
        assertEquals(RemoteState.CANCELLED, companion.jobs.getValue(job.id).state)
        // a late "succeeded" can no longer resurrect it
        assertEquals(JobPhase.CANCELLED, w.store.job(pid, job.id)!!.phase)
    }

    @Test fun interruptedJobCanBeRetriedAndReusesTheRemoteJob() = runBlocking {
        val companion = FakeCompanion()
        var first = true
        companion.scriptFor = { j ->
            if (first) { first = false; listOf({ r: FakeCompanion.RJob -> r.state = RemoteState.RUNNING; r.event("stage_start") },
                                               { r: FakeCompanion.RJob -> r.state = RemoteState.INTERRUPTED; r.event("log") }) }
            else companion.successScript()
        }
        val w = world(companion)
        val (pid, sid, ids) = w.projectWithPhotos()
        val job = w.engine.startJob(pid, sid, "standard", ids)
        val interrupted = w.await(pid, job.id, what = "interrupted") { it.phase.isTerminal }
        assertEquals(JobPhase.INTERRUPTED, interrupted.phase)
        assertNull(interrupted.modelId)                            // never shown as complete
        assertNull(w.store.project(pid)!!.activeModelId)
        w.engine.retryJob(pid, job.id)
        val done = w.await(pid, job.id, what = "completion after retry") { it.phase.isTerminal }
        assertEquals(JobPhase.COMPLETED, done.phase)
        assertEquals(2, done.attempt)
        assertEquals(1, companion.retryCount)
        assertEquals(12_000L, companion.bytesSent.values.sum())    // photos were not uploaded again
    }

    @Test fun restartMidUploadResumesFromTheOffsetsTheCompanionHas() = runBlocking {
        val companion = FakeCompanion().apply { uploadChunkBytes = 500 }
        val gate = CompletableDeferred<Unit>()
        companion.uploadHook = { _, _ -> if (companion.bytesSent.values.sum() >= 5000 && !gate.isCompleted) gate.await() }
        val w1 = world(companion)
        val (pid, sid, ids) = w1.projectWithPhotos()
        val job = w1.engine.startJob(pid, sid, "standard", ids)
        withTimeout(5000) { while (companion.bytesSent.values.sum() < 5000) delay(5) }
        w1.scope.cancel()                                           // "process death"
        delay(50)
        val sentBefore = companion.bytesSent.values.sum()
        assertTrue(sentBefore in 5000 until 12_000)
        assertTrue(FileProjectStore(tmp.root).job(pid, job.id)!!.phase.isActive)

        gate.complete(Unit)
        val w2 = world(companion)                                   // new process: new store + engine, same folder
        w2.engine.resumeActiveJobs()
        w2.engine.resumeActiveJobs()                                // idempotent
        val done = w2.await(pid, job.id, what = "completion after restart") { it.phase.isTerminal }
        assertEquals(JobPhase.COMPLETED, done.phase)
        // every byte was sent exactly once in total: the upload resumed, it did not restart
        assertEquals(12_000L, companion.bytesSent.values.sum())
        assertEquals(1, companion.submitCount)
    }

    @Test fun restartWhileRunningContinuesPollingWithoutResubmitting() = runBlocking {
        val companion = FakeCompanion()
        val hold = CompletableDeferred<Unit>()
        companion.scriptFor = { companion.runningScript(3, companion.successScript().takeLast(1)) }
        var polls = 0
        companion.pollHook = { if (++polls >= 2 && !hold.isCompleted) hold.await() }
        val w1 = world(companion)
        val (pid, sid, ids) = w1.projectWithPhotos()
        val job = w1.engine.startJob(pid, sid, "standard", ids)
        w1.await(pid, job.id, what = "running") { it.phase == JobPhase.RUNNING }
        w1.scope.cancel()
        delay(50)
        hold.complete(Unit)
        val w2 = world(companion)
        assertEquals(JobPhase.RUNNING, w2.store.job(pid, job.id)!!.phase)
        w2.engine.resumeActiveJobs()
        val done = w2.await(pid, job.id, what = "completion after restart") { it.phase.isTerminal }
        assertEquals(JobPhase.COMPLETED, done.phase)
        assertEquals(1, companion.submitCount)
        assertEquals(1, companion.putSessionCount)
        assertEquals(12_000L, companion.bytesSent.values.sum())
        assertNotNull(w2.store.model(pid, done.modelId!!))
    }

    @Test fun remoteJobMissingBecomesInterruptedNotFailedNorComplete() = runBlocking {
        val companion = FakeCompanion()
        companion.scriptFor = { companion.runningScript(10_000) }
        val w = world(companion)
        val (pid, sid, ids) = w.projectWithPhotos()
        val job = w.engine.startJob(pid, sid, "standard", ids)
        w.await(pid, job.id, what = "running") { it.phase == JobPhase.RUNNING }
        companion.jobs.clear()                                      // companion data directory wiped
        val gone = w.await(pid, job.id, what = "interrupted") { it.phase.isTerminal }
        assertEquals(JobPhase.INTERRUPTED, gone.phase)
        assertEquals("remote_job_missing", gone.error!!.code)
        assertNull(gone.modelId)
    }

    @Test fun jobOfAnotherCompanionIsNeverPolledOnTheNewOne() = runBlocking {
        val a = FakeCompanion(serverId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", serverName = "Desk")
        a.scriptFor = { a.runningScript(10_000) }
        val w = world(a)
        val (pid, sid, ids) = w.projectWithPhotos()
        val job = w.engine.startJob(pid, sid, "standard", ids)
        w.await(pid, job.id, what = "running") { it.phase == JobPhase.RUNNING }
        val b = FakeCompanion(serverId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", serverName = "Laptop")
        w.gateway.companion = b.paired()                            // user paired a different computer
        w.engine.wake()
        val moved = w.await(pid, job.id, what = "interrupted") { it.phase.isTerminal }
        assertEquals(JobPhase.INTERRUPTED, moved.phase)
        assertEquals("companion_changed", moved.error!!.code)
        assertTrue(moved.error!!.message.contains("Desk") && moved.error!!.message.contains("Laptop"))
        assertEquals(0, b.calls)                                    // the other computer was never asked about it
    }

    @Test fun damagedDownloadIsRefetchedAndAModelIsOnlyRegisteredWhenChecksumsMatch() = runBlocking {
        val companion = FakeCompanion().apply { corruptDownloads = 1 }
        val w = world(companion)
        val (pid, sid, ids) = w.projectWithPhotos()
        val job = w.engine.startJob(pid, sid, "standard", ids)
        val done = w.await(pid, job.id, what = "completion") { it.phase.isTerminal }
        assertEquals(JobPhase.COMPLETED, done.phase)
        val glb = File(w.store.modelDir(pid, done.modelId!!), "model.glb").readBytes()
        assertEquals(companion.artifact("model.glb", "model").sha256, StorageFiles.sha256(glb))

        // …and when it stays damaged the job fails without ever producing a model
        val bad = FakeCompanion().apply { corruptDownloads = 1000 }
        val w2 = world(bad, tmp.newFolder("second"))
        val (pid2, sid2, ids2) = w2.projectWithPhotos()
        val job2 = w2.engine.startJob(pid2, sid2, "standard", ids2)
        val failed = w2.await(pid2, job2.id, what = "failure") { it.phase.isTerminal }
        assertEquals(JobPhase.FAILED, failed.phase)
        assertNull(failed.modelId)
        assertTrue(w2.store.models(pid2).isEmpty())
        assertNull(w2.store.project(pid2)!!.activeModelId)
    }

    @Test fun permanentUploadRejectionFailsWithASpecificMessage() = runBlocking {
        val companion = FakeCompanion()
        companion.uploadError = { id -> if (id == "f2") api(422, "unsupported_format", "not a decodable image") else null }
        val w = world(companion)
        val (pid, sid, ids) = w.projectWithPhotos()
        val job = w.engine.startJob(pid, sid, "standard", ids)
        val failed = w.await(pid, job.id, what = "failure") { it.phase.isTerminal }
        assertEquals(JobPhase.FAILED, failed.phase)
        assertNotNull(failed.error)
        assertFalse(failed.error!!.message.isBlank())
        assertEquals(0, companion.submitCount)
    }

    @Test fun notPairedFailsImmediatelyWithGuidance() = runBlocking {
        val w = world(null)
        val (pid, sid, ids) = w.projectWithPhotos()
        val job = w.engine.startJob(pid, sid, "standard", ids)
        val failed = w.await(pid, job.id, what = "failure") { it.phase.isTerminal }
        assertEquals(JobPhase.FAILED, failed.phase)
        assertEquals("not_paired", failed.error!!.code)
        assertTrue(failed.error!!.guidance.isNotEmpty())
    }

    @Test fun startJobValidatesItsInput() = runBlocking {
        val w = world(FakeCompanion())
        val (pid, sid, ids) = w.projectWithPhotos()
        for (bad in listOf<suspend () -> Unit>(
            { w.engine.startJob(pid, sid, "standard", emptyList()) },
            { w.engine.startJob(pid, sid, "standard", listOf("nope")) },
            { w.engine.startJob(pid, sid, "../etc", ids) },
            { w.engine.startJob(pid, "00000000-0000-4000-8000-000000000000", "standard", ids) })) {
            try { bad(); throw AssertionError("accepted invalid input") } catch (_: IllegalArgumentException) { }
        }
        assertTrue(w.store.jobs(pid).isEmpty())
    }
}
