package dev.pocket3d.data

import dev.pocket3d.core.net.ArtifactInfo
import dev.pocket3d.core.net.JobError
import dev.pocket3d.core.net.JobSubmitRequest
import dev.pocket3d.core.net.RemoteJob
import dev.pocket3d.core.net.RemoteState
import dev.pocket3d.core.net.SessionFileSpec
import dev.pocket3d.core.net.SessionPutRequest
import dev.pocket3d.core.project.JobEvent
import dev.pocket3d.core.project.JobPhase
import dev.pocket3d.core.project.ReconJob
import dev.pocket3d.core.services.ReconstructionService
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineName
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import java.io.File
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * Keeps the process alive while reconstruction jobs are being supervised. Called with the
 * current list of active (non-terminal) jobs after every change; an empty list means nothing
 * needs the process any more. Implemented on Android by a foreground service.
 */
fun interface SyncKeepAlive {
    fun onActiveJobs(jobs: List<ReconJob>)
}

data class SyncConfig(
    /** Back-off after a transient failure: doubles from the initial value up to the cap. */
    val backoffInitialMs: Long = 1_000,
    val backoffMaxMs: Long = 30_000,
    /** Long-poll duration asked of the companion (≤ 30). */
    val pollWaitSeconds: Int = 25,
    /** Pause between two polls, which also bounds how often a job record is rewritten. */
    val minPollIntervalMs: Long = 250,
    /** `uploadedBytes` is persisted at most once per this interval (≈ 4×/s). */
    val progressIntervalMs: Long = 250,
    val parallelFileUploads: Int = 2,
    /** A damaged download is fetched again this many times in total before the job fails. */
    val maxIntegrityAttempts: Int = 3,
    /** Answers that are not understood are tolerated this many times in a row. */
    val maxProtocolErrors: Int = 3,
    /** How long a "busy with these photos" conflict is waited out before giving up. */
    val maxConflictRetries: Int = 40,
)

/**
 * Durable supervision of reconstruction jobs ([ReconstructionService]).
 *
 * Everything the engine knows lives in the job record on disk, so a supervisor can be killed
 * at any point and restarted by [resumeActiveJobs]: uploads continue from the offsets the
 * companion reports, submission is idempotent (the job id is the companion's job id), polling
 * continues from `lastEventSeq`, downloads resume from their partial files.
 *
 * One coroutine supervises one job. At most one job uploads at a time, with at most
 * [SyncConfig.parallelFileUploads] files in flight. Every phase change goes through
 * `JobStateMachine` (inside [FileProjectStore.updateJob]). Losing contact with the companion
 * never fails a job: it stays in its phase with a `waitingReason` and is retried with
 * exponential back-off (and immediately on [wake]).
 */
class SyncEngine(
    private val store: FileProjectStore,
    private val gateway: CompanionGateway,
    private val scope: CoroutineScope,
    private val keepAlive: SyncKeepAlive = SyncKeepAlive { },
    private val clock: () -> Long = System::currentTimeMillis,
    private val config: SyncConfig = SyncConfig(),
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : ReconstructionService {

    private class JobGone : Exception()
    private class Permanent(val error: JobError) : Exception(error.message)

    private val lock = Any()
    private val supervisors = HashMap<String, Job>()
    private val uploadSlot = Mutex()
    private val wakeCounter = MutableStateFlow(0)
    private val active = MutableStateFlow<Map<String, ReconJob>>(emptyMap())
    private val _activeJobs = MutableStateFlow<List<ReconJob>>(emptyList())

    /** Jobs currently being supervised that are not finished (for progress UI / notifications). */
    val activeJobs: StateFlow<List<ReconJob>> = _activeJobs.asStateFlow()

    // =========================================================================================
    // ReconstructionService
    // =========================================================================================
    override suspend fun startJob(projectId: String, sessionId: String, preset: String, frameIds: List<String>): ReconJob {
        val session = store.session(projectId, sessionId) ?: throw IllegalArgumentException("unknown capture session")
        val byId = session.frames.associateBy { it.id }
        val ids = frameIds.distinct()
        require(ids.isNotEmpty()) { "a reconstruction needs photos" }
        val frames = ids.map { byId[it] ?: throw IllegalArgumentException("a selected photo is not part of this capture") }
        require(PRESET.matches(preset)) { "invalid preset" }
        val companion = gateway.current()
        val job = store.createJob(projectId, sessionId, preset, ids, frames.sumOf { it.sizeBytes },
            companion?.serverId, companion?.serverName)
        track(job)
        ensureSupervised(projectId, job.id)
        return job
    }

    override suspend fun cancelJob(projectId: String, jobId: String) {
        val job = store.job(projectId, jobId) ?: return
        if (!job.phase.canCancel) return
        // Durable reminder that the companion may still have to be told (see deliverRemoteCancel).
        withContext(io) { cancelMarker(job).apply { parentFile?.mkdirs() }.createNewFile() }
        val updated = store.updateJob(projectId, jobId, JobEvent.CancelRequested) { j, changed ->
            if (changed) j.copy(waitingReason = null, message = "Cancelled", finishedAtMs = clock()) else j
        }
        stopSupervisor(jobId)
        if (updated == null) return
        track(updated)
        if (updated.phase == JobPhase.CANCELLED) ensureSupervised(projectId, jobId)   // delivers the remote cancel
        else withContext(io) { cancelMarker(job).delete() }                            // it had already finished
    }

    override suspend fun retryJob(projectId: String, jobId: String) {
        val job = store.job(projectId, jobId) ?: return
        if (!job.phase.canRetry) return
        stopSupervisor(jobId)
        withContext(io) {
            cancelMarker(job).delete()
            File(store.jobDir(projectId, jobId), SPARSE_PREVIEW).delete()
        }
        val companion = gateway.current()
        val updated = store.updateJob(projectId, jobId, JobEvent.RetryRequested) { j, changed ->
            if (!changed) return@updateJob j
            // A different companion knows nothing about this job: start from scratch there.
            val moved = companion != null && companion.serverId != j.companionId
            j.copy(
                companionId = companion?.serverId ?: j.companionId,
                companionName = companion?.serverName ?: j.companionName,
                remoteState = if (moved) null else j.remoteState,
                lastEventSeq = if (moved) 0 else j.lastEventSeq,
                // `attempt` mirrors the companion's attempt counter: it only advances when there
                // is a remote job to re-run.
                attempt = if (moved) 1 else if (j.remoteState != null) j.attempt + 1 else j.attempt,
                uploadedBytes = 0, stage = null, stageIndex = 0, stageCount = 0, stageProgress = 0f, overallProgress = 0f,
                message = "", queuePosition = 0, error = null, diagnostics = JsonObject(emptyMap()),
                hasSparsePreview = false, waitingReason = null, finishedAtMs = null,
            )
        } ?: return
        track(updated)
        if (updated.phase.isActive) ensureSupervised(projectId, jobId)
    }

    /** Removes the job from the phone (a model it produced is kept) and, best effort, from the companion. */
    override suspend fun deleteJob(projectId: String, jobId: String) {
        val job = store.job(projectId, jobId) ?: return
        stopSupervisor(jobId)
        untrack(jobId)
        val companion = gateway.current()
        if (companion != null && companion.serverId == job.companionId) {
            scope.launch {
                try { companion.api.deleteJob(jobId) } catch (_: CompanionException) { }
            }
        }
        store.deleteJobRecord(projectId, jobId)
    }

    override fun resumeActiveJobs() {
        for (job in store.allJobs()) {
            val pendingCancel = job.phase == JobPhase.CANCELLED && cancelMarker(job).exists()
            if (job.phase.isActive || pendingCancel) {
                if (job.phase.isActive) track(job)
                ensureSupervised(job.projectId, job.id)
            }
        }
    }

    /** The companion may be reachable again (network change, new pairing): retry now instead of waiting. */
    fun wake() {
        wakeCounter.update { it + 1 }
        resumeActiveJobs()
    }

    // =========================================================================================
    // supervisors
    // =========================================================================================
    private fun ensureSupervised(projectId: String, jobId: String) = synchronized(lock) {
        if (supervisors[jobId]?.isActive == true) return@synchronized
        supervisors[jobId] = scope.launch(CoroutineName("recon-job")) {
            try {
                supervise(projectId, jobId)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Never let one job take the others down; it is picked up again on the next resume.
            }
        }
    }

    private suspend fun stopSupervisor(jobId: String) {
        val job = synchronized(lock) { supervisors.remove(jobId) } ?: return
        job.cancelAndJoin()
    }

    private fun publishActive(next: Map<String, ReconJob>) {
        val list = next.values.sortedBy { it.createdAtMs }
        _activeJobs.value = list
        try { keepAlive.onActiveJobs(list) } catch (_: Exception) { }
    }

    private fun track(job: ReconJob) {
        if (!job.phase.isActive) return untrack(job.id)
        synchronized(lock) {
            active.value = active.value + (job.id to job)
            publishActive(active.value)
        }
    }

    private fun untrack(jobId: String) = synchronized(lock) {
        if (jobId !in active.value) return@synchronized
        active.value = active.value - jobId
        publishActive(active.value)
    }

    private fun cancelMarker(job: ReconJob) = File(store.jobDir(job.projectId, job.id), CANCEL_MARKER)

    /** Rewrites the job; changes to a job that already reached a terminal phase are dropped. */
    private suspend fun update(job: ReconJob, event: JobEvent? = null, change: (ReconJob) -> ReconJob): ReconJob {
        val stored = store.updateJob(job.projectId, job.id, event) { j, changed ->
            if (!changed && j.phase.isTerminal) j else change(j)
        }
        if (stored == null) { untrack(job.id); throw JobGone() }
        track(stored)
        return stored
    }

    private suspend fun waitBackoff(ms: Long, seenWake: Int) {
        withTimeoutOrNull(ms) { wakeCounter.first { it != seenWake } }
    }

    private suspend fun supervise(projectId: String, jobId: String) {
        var backoff = config.backoffInitialMs
        var integrityFailures = 0
        var protocolFailures = 0
        var conflicts = 0
        var notFoundWhileUploading = 0
        var localFailures = 0
        while (currentCoroutineContext().isActive) {
            val job = store.job(projectId, jobId) ?: run { untrack(jobId); return }
            val seenWake = wakeCounter.value
            if (job.phase.isTerminal) {
                untrack(jobId)
                if (job.phase != JobPhase.CANCELLED || !cancelMarker(job).exists()) return
                if (deliverRemoteCancel(job)) return
                waitBackoff(backoff, seenWake)
                backoff = (backoff * 2).coerceAtMost(config.backoffMaxMs)
                try { gateway.probe() } catch (_: CompanionException) { }
                continue
            }
            track(job)
            try {
                val api = companionFor(job) ?: continue
                when (job.phase) {
                    JobPhase.PENDING, JobPhase.UPLOADING -> uploadAndSubmit(job, api)
                    JobPhase.QUEUED, JobPhase.RUNNING -> poll(job, api)
                    JobPhase.DOWNLOADING -> download(job, api)
                    else -> return
                }
                backoff = config.backoffInitialMs
                protocolFailures = 0; conflicts = 0; notFoundWhileUploading = 0; localFailures = 0
            } catch (e: CancellationException) {
                throw e
            } catch (_: JobGone) {
                return
            } catch (e: Permanent) {
                fail(job, e.error)
            } catch (e: InsufficientStorageException) {
                fail(job, JobError("phone_storage_full",
                    "The phone does not have enough free storage for the result " +
                        "(${e.requiredBytes / 1_000_000 + 1} MB needed, ${e.freeBytes / 1_000_000} MB free).",
                    listOf("Free some storage on the phone, then retry — the reconstruction itself does not run again.")))
            } catch (e: CompanionException) {
                val uploading = job.phase == JobPhase.PENDING || job.phase == JobPhase.UPLOADING
                val waitReason: String? = when {
                    e.kind == CompanionException.Kind.UNREACHABLE -> "Companion unreachable — retrying"
                    e.kind == CompanionException.Kind.FINGERPRINT_MISMATCH ->
                        "A different computer answers at the companion's address — waiting for ${job.companionName ?: "the companion"}"
                    e.isTransient -> "The companion is busy — retrying"
                    e.kind == CompanionException.Kind.UNAUTHORIZED -> null
                    e.isNotFound && !uploading -> null
                    e.isNotFound -> if (++notFoundWhileUploading <= 3) "The companion lost the upload — starting it again" else null
                    e.kind == CompanionException.Kind.INTEGRITY && job.phase == JobPhase.DOWNLOADING ->
                        if (++integrityFailures < config.maxIntegrityAttempts) "The download arrived damaged — fetching it again" else null
                    e.kind == CompanionException.Kind.PROTOCOL ->
                        if (++protocolFailures < config.maxProtocolErrors) "Unexpected answer from the companion — retrying" else null
                    e.code == "conflict" && uploading ->
                        if (++conflicts <= config.maxConflictRetries) "The companion is still working with these photos — waiting" else null
                    e.code == "incomplete_upload" && uploading ->
                        if (++conflicts <= 3) "Finishing the upload" else null
                    else -> null
                }
                if (waitReason != null) {
                    update(job) { it.copy(waitingReason = waitReason) }
                    waitBackoff(backoff, seenWake)
                    backoff = (backoff * 2).coerceAtMost(config.backoffMaxMs)
                    if (e.kind == CompanionException.Kind.UNREACHABLE || e.kind == CompanionException.Kind.FINGERPRINT_MISMATCH) {
                        try { gateway.probe() } catch (_: CompanionException) { }
                    }
                } else if (e.isNotFound && !uploading) {
                    remoteMissing(job, JobError("remote_job_missing",
                        "${job.companionName ?: "The companion"} no longer has this job (its data was removed or reset). " +
                            "Nothing was completed.",
                        listOf("Retry to upload the photos and run the reconstruction again.")))
                } else {
                    fail(job, describe(e, job))
                }
            } catch (e: IOException) {
                // Local storage trouble (not the network: that is always a CompanionException).
                if (++localFailures >= 3) {
                    fail(job, JobError("phone_storage_error", "The phone could not read or write the job's files " +
                        "(${e.javaClass.simpleName}).", listOf("Check the phone's free storage and retry.")))
                } else {
                    waitBackoff(backoff, seenWake)
                    backoff = (backoff * 2).coerceAtMost(config.backoffMaxMs)
                }
            }
        }
    }

    private suspend fun fail(job: ReconJob, error: JobError) {
        try {
            update(job, JobEvent.TransferFailed(permanent = true)) {
                it.copy(error = error, waitingReason = null, finishedAtMs = clock())
            }
        } catch (_: JobGone) {
        }
    }

    /** @param forget the companion really has no such job any more (a retry must resubmit it) */
    private suspend fun remoteMissing(job: ReconJob, error: JobError, forget: Boolean = true) {
        try {
            update(job, JobEvent.RemoteJobMissing) {
                it.copy(error = error, waitingReason = null, remoteState = if (forget) null else it.remoteState,
                    lastEventSeq = if (forget) 0 else it.lastEventSeq, finishedAtMs = clock())
            }
        } catch (_: JobGone) {
        }
    }

    private fun describe(e: CompanionException, job: ReconJob): JobError {
        val name = job.companionName ?: "The companion"
        return when {
            e.kind == CompanionException.Kind.UNAUTHORIZED -> JobError("unauthorized",
                "$name no longer accepts this phone (it was removed from the companion's device list).",
                listOf("Pair the phone with the companion again, then retry."))
            e.code == "insufficient_storage" -> JobError(e.code,
                "$name does not have enough free disk space for these photos.",
                listOf("Free disk space on the computer (or delete old captures from the companion), then retry."))
            e.code == "limit_exceeded" -> JobError(e.code, "The companion rejected the photo set: ${e.message}",
                listOf("Select a set of photos within the companion's limits and start a new reconstruction."))
            e.code == "unsupported_format" -> JobError(e.code, e.message,
                listOf("Exclude that photo and start the reconstruction again."))
            e.kind == CompanionException.Kind.INTEGRITY && job.phase == JobPhase.DOWNLOADING -> JobError("checksum_mismatch",
                "The result arrived damaged ${config.maxIntegrityAttempts} times in a row (checksum mismatch).",
                listOf("Check the Wi-Fi connection and retry — only the download is repeated."))
            e.kind == CompanionException.Kind.INTEGRITY -> JobError(e.code, e.message,
                listOf("Remove the damaged photo from the capture and start a new reconstruction."))
            e.kind == CompanionException.Kind.PROTOCOL -> JobError("protocol_error",
                "$name sent answers this app does not understand.",
                listOf("Make sure the app and the companion are the same version."))
            else -> JobError(e.code.ifEmpty { "companion_error" }, e.message)
        }
    }

    /**
     * The API of the companion that owns [job], or null after the job was moved to a terminal
     * phase because there is no such companion any more. A job is never sent to — or polled
     * on — a companion other than the one it remembers.
     */
    private suspend fun companionFor(job: ReconJob): CompanionApi? {
        val current = gateway.current()
        if (current == null) {
            fail(job, JobError("not_paired", "The phone is not paired with a companion computer.",
                listOf("Pair with the companion (scan its QR code), then retry.")))
            return null
        }
        if (job.companionId == null) {
            if (job.phase == JobPhase.PENDING) {
                update(job) { it.copy(companionId = current.serverId, companionName = current.serverName) }
                return current.api
            }
        } else if (job.companionId == current.serverId) {
            return current.api
        }
        val error = JobError("companion_changed",
            "This job belongs to ${job.companionName ?: "another companion"}, but the phone is now paired with " +
                "${current.serverName}. It was not continued there.",
            listOf("Retry to upload the photos to ${current.serverName} and run the reconstruction there."))
        if (job.phase == JobPhase.PENDING || job.phase == JobPhase.UPLOADING) fail(job, error)
        else remoteMissing(job, error, forget = false)
        return null
    }

    // =========================================================================================
    // upload + submit
    // =========================================================================================
    private suspend fun uploadAndSubmit(job0: ReconJob, api: CompanionApi) {
        val session = store.session(job0.projectId, job0.sessionId) ?: throw Permanent(JobError("photos_missing",
            "The capture this job was started from has been deleted from the phone."))
        val byId = session.frames.associateBy { it.id }
        val missing = job0.frameIds.count { it !in byId }
        if (missing > 0) throw Permanent(JobError("photos_missing",
            "$missing of the photos selected for this job have since been deleted from the phone.",
            listOf("Start a new reconstruction with the photos that are left.")))
        val frames = job0.frameIds.map { byId.getValue(it) }
        val total = frames.sumOf { it.sizeBytes }
        val projectName = store.project(job0.projectId)?.name ?: ""

        if (uploadSlot.isLocked) update(job0) { it.copy(waitingReason = "Waiting for another upload to finish") }
        uploadSlot.withLock {
            var job = update(job0, JobEvent.UploadStarted) {
                it.copy(startedAtMs = it.startedAtMs ?: clock(), totalBytes = total, waitingReason = null,
                    message = "Preparing upload")
            }
            if (job.phase != JobPhase.UPLOADING) return

            val manifest = SessionPutRequest(
                name = projectName.take(200),
                capture = CaptureMetadata.build(session, frames),
                files = frames.map { SessionFileSpec(it.id, it.name.take(255), it.sizeBytes, it.sha256) })
            var status = api.putSession(job.sessionId, manifest)

            var rounds = 0
            while (!status.complete) {
                if (++rounds > 3) throw CompanionException(CompanionException.Kind.API, "incomplete_upload",
                    "The companion still reports the upload as incomplete.", 409)
                val remote = status.files.associateBy { it.id }
                val have = frames.associate { f ->
                    val st = remote[f.id]
                    f.id to AtomicLong(if (st == null) 0 else if (st.complete) f.sizeBytes else st.received.coerceIn(0, f.sizeBytes))
                }
                val done = AtomicInteger(frames.count { remote[it.id]?.complete == true })
                val uploading = job
                suspend fun persist() {
                    update(uploading) {
                        it.copy(uploadedBytes = have.values.sumOf { v -> v.get() }.coerceIn(0, total),
                            message = "Uploading ${done.get()}/${frames.size} photos", waitingReason = null)
                    }
                }
                persist()
                coroutineScope {
                    val ticker = launch { while (true) { delay(config.progressIntervalMs); persist() } }
                    val permits = Semaphore(config.parallelFileUploads)
                    frames.filter { remote[it.id]?.complete != true }.map { f ->
                        launch {
                            permits.withPermit {
                                val counter = have.getValue(f.id)
                                try {
                                    api.uploadFile(job.sessionId, f.id, store.frameFile(job.projectId, job.sessionId, f),
                                        f.sizeBytes, f.sha256, counter.get()) { counter.set(it.coerceIn(0, f.sizeBytes)) }
                                } catch (e: CompanionException) {
                                    throw if (e.code == "unsupported_format" || e.code == "local_file_changed" ||
                                        e.code == "checksum_mismatch") {
                                        CompanionException(e.kind, e.code, "Photo \"${f.name}\": ${e.message}", e.httpStatus,
                                            e.received, e.retryAfterSeconds, e)
                                    } else e
                                }
                                counter.set(f.sizeBytes)
                                done.incrementAndGet()
                            }
                        }
                    }.joinAll()
                    ticker.cancel()
                }
                persist()
                // The companion's own word that every file is stored, verified and decodable.
                status = api.getSession(job.sessionId)
            }

            job = update(job) { it.copy(uploadedBytes = total, message = "Submitting", waitingReason = null) }
            var remoteJob = api.submitJob(job.id, JobSubmitRequest(job.sessionId, job.preset, job.settings))
            // A retry of a job the companion already knows: re-run it there instead of resubmitting.
            var waits = 0
            while (remoteJob.state == RemoteState.CANCELLING && remoteJob.attempt < job.attempt && waits++ < 60) {
                delay(config.minPollIntervalMs * 2)
                remoteJob = api.pollJob(job.id, job.lastEventSeq, 5).job
            }
            if (remoteJob.state in RETRYABLE_REMOTE && remoteJob.attempt < job.attempt) remoteJob = api.retryJob(job.id)
            val submitted = remoteJob
            update(job, JobEvent.UploadFinishedAndSubmitted) {
                it.copy(uploadedBytes = total, remoteState = submitted.state, attempt = submitted.attempt.coerceAtLeast(1),
                    queuePosition = submitted.queuePosition, message = "", waitingReason = null)
            }
        }
    }

    // =========================================================================================
    // poll
    // =========================================================================================
    private suspend fun applyRemote(job: ReconJob, remote: RemoteJob, lastSeq: Long): ReconJob =
        update(job, JobEvent.RemoteStateChanged(remote.state)) { j ->
            val error = when (j.phase) {
                JobPhase.FAILED -> remote.error?.takeIf { it.message.isNotEmpty() || it.code.isNotEmpty() }
                    ?: JobError("failed", remote.message.ifEmpty { "The reconstruction failed on the companion." })
                JobPhase.INTERRUPTED -> JobError("interrupted",
                    "${j.companionName ?: "The companion"} stopped or restarted while working on this job. " +
                        "Nothing was completed; the photos are still on the phone.",
                    listOf("Retry — stages that had already finished are reused."))
                JobPhase.CANCELLED -> null
                else -> null
            }
            j.copy(
                remoteState = remote.state,
                attempt = remote.attempt.coerceAtLeast(1),
                stage = remote.stage,
                stageIndex = remote.stageIndex, stageCount = remote.stageCount,
                stageProgress = remote.stageProgress.toFloat().coerceIn(0f, 1f),
                overallProgress = remote.overallProgress.toFloat().coerceIn(0f, 1f),
                message = when (j.phase) {
                    JobPhase.DOWNLOADING -> "Downloading result"
                    JobPhase.CANCELLED -> "Cancelled on the companion"
                    else -> remote.message
                },
                queuePosition = remote.queuePosition,
                lastEventSeq = lastSeq.coerceAtLeast(0),
                error = error,
                // Shallow merge by key, like the companion does with the worker's diagnostics events.
                diagnostics = if (remote.diagnostics.isEmpty()) j.diagnostics else JsonObject(j.diagnostics + remote.diagnostics),
                waitingReason = null,
                finishedAtMs = if (j.phase.isTerminal) clock() else null,
            )
        }

    private suspend fun poll(job: ReconJob, api: CompanionApi) {
        val resp = api.pollJob(job.id, job.lastEventSeq, config.pollWaitSeconds)
        val updated = applyRemote(job, resp.job, resp.lastSeq)
        if (updated.phase.isTerminal) return
        if (!updated.hasSparsePreview) fetchSparsePreview(updated, resp.job, api)
        if (updated.phase == JobPhase.QUEUED || updated.phase == JobPhase.RUNNING) delay(config.minPollIntervalMs)
    }

    /** The provisional preview is a convenience: failing to fetch it never affects the job. */
    private suspend fun fetchSparsePreview(job: ReconJob, remote: RemoteJob, api: CompanionApi) {
        val artifact = remote.artifacts.firstOrNull { it.name == SPARSE_PREVIEW } ?: return
        if (artifact.size > MAX_PREVIEW_BYTES) return
        try {
            api.downloadArtifact(job.id, artifact, File(store.jobDir(job.projectId, job.id), SPARSE_PREVIEW))
            update(job) { it.copy(hasSparsePreview = true) }
        } catch (_: CompanionException) {
            // tried again with the next poll
        }
    }

    // =========================================================================================
    // download + register
    // =========================================================================================
    private suspend fun download(job: ReconJob, api: CompanionApi) {
        val resp = api.pollJob(job.id, job.lastEventSeq, 0)
        val remote = resp.job
        if (remote.state != RemoteState.SUCCEEDED) {
            // Only a job the companion itself calls succeeded is ever downloaded.
            val updated = applyRemote(job, remote, resp.lastSeq)
            if (updated.phase == JobPhase.DOWNLOADING) delay(config.minPollIntervalMs * 4)
            return
        }
        val announced = remote.artifacts.associateBy { it.name }
        val glb = announced[FileProjectStore.MODEL_GLB] ?: throw Permanent(JobError("invalid_result",
            "The companion reported success, but its result contains no model."))
        val wanted = FileProjectStore.RESULT_FILES.mapNotNull { announced[it] }
        val totalBytes = wanted.sumOf { it.size }.coerceAtLeast(1)
        val dir = File(store.jobDir(job.projectId, job.id), DOWNLOAD_DIR)
        val files = LinkedHashMap<String, File>()
        val current = update(job) {
            it.copy(message = "Downloading result", waitingReason = null, overallProgress = 1f,
                diagnostics = if (remote.diagnostics.isEmpty()) it.diagnostics else JsonObject(it.diagnostics + remote.diagnostics))
        }
        val before = AtomicLong(0)
        val inFlight = AtomicLong(0)
        coroutineScope {
            val ticker = launch {
                while (true) {
                    delay(config.progressIntervalMs)
                    val got = (before.get() + inFlight.get()).coerceIn(0, totalBytes)
                    update(current) {
                        it.copy(message = "Downloading result (${got / 1_000_000}/${totalBytes / 1_000_000 + 1} MB)")
                    }
                }
            }
            for (artifact in wanted) {
                val dest = File(dir, artifact.name)
                val present = withContext(io) { dir.mkdirs(); dest.isFile && matches(dest, artifact) }
                if (!present) {
                    // Space for what is still missing (a partial file already occupies its part).
                    val part = File(dir, artifact.name + ".part")
                    withContext(io) { store.requireFreeSpace((artifact.size - part.length()).coerceAtLeast(0)) }
                    inFlight.set(0)
                    api.downloadArtifact(job.id, artifact, dest) { inFlight.set(it) }
                }
                inFlight.set(0)
                before.addAndGet(artifact.size)
                files[artifact.name] = dest
            }
            ticker.cancel()
        }
        val stats = withContext(io) { DiagnosticsReader.read(files["diagnostics.json"]) }
        try {
            store.registerCompletedModel(job.projectId, job.id, files, glb.sha256.lowercase(), glb.size, stats)
        } catch (_: IllegalStateException) {
            return   // cancelled (or deleted) in the meantime: the previous model stays active
        } catch (e: InsufficientStorageException) {
            throw e
        } catch (e: IOException) {
            withContext(io) { StorageFiles.deleteRecursively(dir) }
            throw CompanionException(CompanionException.Kind.INTEGRITY, "checksum_mismatch",
                "The downloaded result could not be verified.", cause = e)
        }
        withContext(io) { StorageFiles.deleteRecursively(dir) }
        store.job(job.projectId, job.id)?.let { track(it) }
    }

    private fun matches(file: File, artifact: ArtifactInfo): Boolean {
        if (file.length() != artifact.size) return false
        return StorageFiles.sha256(file).sha256 == artifact.sha256.lowercase()
    }

    // =========================================================================================
    // cancellation on the companion
    // =========================================================================================
    /** @return true when there is nothing left to tell the companion. */
    private suspend fun deliverRemoteCancel(job: ReconJob): Boolean {
        val marker = cancelMarker(job)
        val companion = gateway.current()
        if (companion == null || companion.serverId != job.companionId) {
            withContext(io) { marker.delete() }
            return true
        }
        return try {
            val remote = companion.api.cancelJob(job.id)
            store.updateJob(job.projectId, job.id) { j, _ ->
                if (j.phase == JobPhase.CANCELLED) j.copy(remoteState = remote.state) else j
            }
            withContext(io) { marker.delete() }
            true
        } catch (e: CompanionException) {
            val retryLater = e.kind == CompanionException.Kind.UNREACHABLE ||
                e.kind == CompanionException.Kind.FINGERPRINT_MISMATCH || e.isTransient
            if (!retryLater) withContext(io) { marker.delete() }   // 404: it never got there; 401: not ours any more
            !retryLater
        }
    }

    companion object {
        internal const val SPARSE_PREVIEW = "sparse_preview.json"
        internal const val CANCEL_MARKER = "remote-cancel.pending"
        internal const val DOWNLOAD_DIR = "download"
        private const val MAX_PREVIEW_BYTES = 64L * 1024 * 1024
        private val RETRYABLE_REMOTE = setOf(RemoteState.FAILED, RemoteState.CANCELLED, RemoteState.INTERRUPTED)
        private val PRESET = Regex("^[a-z0-9_-]{1,32}$")
    }
}

/** Honest one-line descriptions of what a job is doing (notification, job cards). */
object SyncText {
    fun stageLabel(stage: String?): String = when (stage) {
        "ingest" -> "reading photos"
        "features" -> "finding features"
        "matching" -> "matching photos"
        "sfm" -> "locating cameras"
        "undistort" -> "preparing images"
        "dense" -> "dense reconstruction"
        "mesh" -> "building surface"
        "refine" -> "refining surface"
        "texture" -> "texturing"
        "package" -> "packaging model"
        null, "" -> "working"
        else -> stage
    }

    fun describe(job: ReconJob): String {
        job.waitingReason?.let { return it }
        val companion = job.companionName?.takeIf { it.isNotBlank() } ?: "Companion"
        return when (job.phase) {
            JobPhase.PENDING -> "Preparing upload"
            JobPhase.UPLOADING -> job.message.ifEmpty { "Uploading photos" }
            JobPhase.QUEUED ->
                if (job.queuePosition > 1) "$companion: waiting in queue (position ${job.queuePosition})"
                else "$companion: waiting to start"
            JobPhase.RUNNING -> "$companion: ${stageLabel(job.stage)} ${(job.stageProgress * 100).toInt()}%"
            JobPhase.DOWNLOADING -> job.message.ifEmpty { "Downloading result" }
            JobPhase.COMPLETED -> "Model ready"
            JobPhase.FAILED -> job.error?.message?.takeIf { it.isNotEmpty() } ?: "Reconstruction failed"
            JobPhase.CANCELLED -> "Cancelled"
            JobPhase.INTERRUPTED -> job.error?.message?.takeIf { it.isNotEmpty() } ?: "Interrupted — can be retried"
        }
    }

    /** 0..1 for a progress bar, or null when the amount of remaining work is unknown. */
    fun progress(job: ReconJob): Float? = when (job.phase) {
        JobPhase.UPLOADING -> if (job.totalBytes > 0) (job.uploadedBytes.toFloat() / job.totalBytes).coerceIn(0f, 1f) else null
        JobPhase.RUNNING -> job.overallProgress.coerceIn(0f, 1f)
        else -> null
    }
}
