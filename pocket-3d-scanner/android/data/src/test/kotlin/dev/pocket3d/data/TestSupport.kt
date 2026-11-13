package dev.pocket3d.data

import dev.pocket3d.core.net.ArtifactInfo
import dev.pocket3d.core.net.HelloResponse
import dev.pocket3d.core.net.JobError
import dev.pocket3d.core.net.JobEvent as WireEvent
import dev.pocket3d.core.net.JobPollResponse
import dev.pocket3d.core.net.JobSubmitRequest
import dev.pocket3d.core.net.PairResponse
import dev.pocket3d.core.net.RemoteJob
import dev.pocket3d.core.net.RemoteState
import dev.pocket3d.core.net.SessionFileSpec
import dev.pocket3d.core.net.SessionPutRequest
import dev.pocket3d.core.net.SessionStatus
import dev.pocket3d.core.net.StatusResponse
import dev.pocket3d.core.project.Frame
import dev.pocket3d.core.project.JobEvent
import dev.pocket3d.core.project.ReconJob
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.io.File
import java.util.Random

internal fun randomBytes(n: Int, seed: Long): ByteArray = ByteArray(n).also { Random(seed).nextBytes(it) }

internal suspend fun FileProjectStore.addFrame(projectId: String, sessionId: String, id: String, bytes: ByteArray,
                                               format: String = "jpeg", name: String = "IMG_$id.jpg"): Frame {
    val tmp = newFrameTempFile(projectId, sessionId)
    tmp.writeBytes(bytes)
    return commitFrame(projectId, sessionId,
        Frame(id = id, name = name, file = "", width = 640, height = 480, format = format, timestampMs = 1_700_000_000_000), tmp)
}

/** Drives a freshly created job to DOWNLOADING through the state machine, like the sync engine does. */
internal suspend fun FileProjectStore.driveToDownloading(job: ReconJob): ReconJob {
    updateJob(job.projectId, job.id, JobEvent.UploadStarted)
    updateJob(job.projectId, job.id, JobEvent.UploadFinishedAndSubmitted)
    return updateJob(job.projectId, job.id, JobEvent.RemoteStateChanged("succeeded"))!!
}

internal const val DIAGNOSTICS_JSON = """{"mesh":{"vertices":1234,"faces":2345,"surface_area":1.5},
 "texture":{"pages":[{"width":2048,"height":2048,"bytes":1000,"format":"jpeg"},{"width":1024,"height":1024,"bytes":500,"format":"jpeg"}]},
 "sfm":{"input_frames":3,"registered":3},
 "scale":{"units":"arbitrary","source":"none","meters_per_unit":null,"relative_uncertainty":null,"note":"Units are arbitrary."},
 "job":{"settings_fingerprint":"fp-123"},"peak_rss_mb":512.5}"""

internal fun api(status: Int, code: String, message: String = code, received: Long? = null) =
    CompanionException(CompanionException.Kind.API, code, message, status, received)

/**
 * Scripted in-memory companion at the level of [CompanionApi]: it keeps sessions, upload
 * offsets and jobs like the real server and advances each job one scripted step per poll.
 * Every call is counted so tests can prove that no work was duplicated.
 */
internal class FakeCompanion(val serverId: String = "11111111-1111-4111-8111-111111111111",
                             val serverName: String = "Workstation") : CompanionApi {
    class RFile(var spec: SessionFileSpec, var received: Long = 0, var complete: Boolean = false)
    class RSession(var manifest: SessionPutRequest, val files: LinkedHashMap<String, RFile>)
    class RJob(val id: String, val body: JobSubmitRequest) {
        var state = RemoteState.QUEUED
        var attempt = 1
        var queuePosition = 1
        var stage: String? = null
        var stageIndex = 0
        var stageProgress = 0.0
        var overall = 0.0
        var message = ""
        var error: JobError? = null
        var diagnostics: JsonObject = JsonObject(emptyMap())
        val artifacts = ArrayList<ArtifactInfo>()
        val events = ArrayList<WireEvent>()
        val script = ArrayDeque<(RJob) -> Unit>()

        fun event(type: String) {
            events += WireEvent(seq = events.size + 1L, t = 0.0, type = type, stage = stage, progress = stageProgress,
                overall = overall, message = message)
        }

        fun toRemote() = RemoteJob(jobId = id, sessionId = body.sessionId, preset = body.preset, state = state,
            attempt = attempt, queuePosition = if (state == RemoteState.QUEUED) queuePosition else 0, stage = stage,
            stageIndex = stageIndex, stageCount = 9, stageProgress = stageProgress, overallProgress = overall,
            message = message, error = error, diagnostics = diagnostics, artifacts = artifacts.toList())
    }

    // ---- behaviour switches ----------------------------------------------------------------
    var unreachable = false
    var unauthorized = false
    var putSessionError: CompanionException? = null
    var uploadError: ((fileId: String) -> CompanionException?)? = null
    /** Called before each uploaded chunk; may suspend forever or throw. */
    var uploadHook: (suspend (fileId: String, received: Long) -> Unit)? = null
    /** Called at the start of each poll; may suspend forever or throw. */
    var pollHook: (suspend (job: RJob) -> Unit)? = null
    var uploadChunkBytes = 1_000L
    var stepDelayMs = 10L
    var corruptDownloads = 0
    var scriptFor: (RJob) -> List<(RJob) -> Unit> = { successScript() }
    var helloError: CompanionException? = null
    var helloProduct = "pocket3d-companion"
    var pairError: CompanionException? = null
    var pairingCode = "ABCD2345"

    // ---- state + counters ------------------------------------------------------------------
    val sessions = HashMap<String, RSession>()
    val jobs = HashMap<String, RJob>()
    val artifactBytes = HashMap<String, ByteArray>()
    /** Updated from parallel uploads on real dispatchers: thread-safe on purpose. */
    val bytesSent = java.util.concurrent.ConcurrentHashMap<String, Long>()
    val pollSince = ArrayList<Long>()
    val downloads = ArrayList<String>()
    val deletedSessions = ArrayList<String>()
    val deletedJobs = ArrayList<String>()
    val pairedDeviceIds = ArrayList<String?>()
    var calls = 0
    var putSessionCount = 0
    var submitCount = 0
    var retryCount = 0
    var cancelCount = 0
    var uploadsInFlight = 0
    var maxUploadsInFlight = 0
    val sessionsUploading = HashSet<String>()
    var maxSessionsUploading = 0

    init {
        artifactBytes["sparse_preview.json"] = """{"format":1,"points":[],"cameras":[]}""".toByteArray()
        artifactBytes["model.glb"] = randomBytes(5_000, 99)
        artifactBytes["cameras.json"] = """{"format":1,"cameras":[]}""".toByteArray()
        artifactBytes["diagnostics.json"] = DIAGNOSTICS_JSON.toByteArray()
    }

    fun artifact(name: String, kind: String): ArtifactInfo {
        val b = artifactBytes.getValue(name)
        return ArtifactInfo(name, b.size.toLong(), StorageFiles.sha256(b), kind)
    }

    fun successScript(): List<(RJob) -> Unit> = listOf(
        { j -> j.state = RemoteState.RUNNING; j.stage = "features"; j.stageIndex = 1; j.stageProgress = 0.5; j.overall = 0.1
            j.message = "features 1/2"; j.event("stage_progress") },
        { j -> j.stage = "sfm"; j.stageIndex = 3; j.stageProgress = 0.9; j.overall = 0.4; j.message = "sfm"
            j.artifacts += artifact("sparse_preview.json", "preview")
            j.diagnostics = buildJsonObject { put("registered_images", JsonPrimitive(3)) }; j.event("artifact") },
        { j -> j.stage = "dense"; j.stageIndex = 5; j.stageProgress = 0.42; j.overall = 0.61; j.message = "Depth maps 21/50"
            j.diagnostics = JsonObject(j.diagnostics + ("dense_points" to JsonPrimitive(1000))); j.event("stage_progress") },
        { j -> j.state = RemoteState.SUCCEEDED; j.stage = "package"; j.stageIndex = 8; j.stageProgress = 1.0; j.overall = 1.0
            j.message = "done"
            j.artifacts += artifact("model.glb", "model"); j.artifacts += artifact("cameras.json", "cameras")
            j.artifacts += artifact("diagnostics.json", "diagnostics"); j.event("stage_end") },
    )

    fun failScript(error: JobError): List<(RJob) -> Unit> = listOf(
        { j -> j.state = RemoteState.RUNNING; j.stage = "sfm"; j.stageIndex = 3; j.overall = 0.3; j.event("stage_start") },
        { j -> j.state = RemoteState.FAILED; j.error = error; j.message = error.message; j.event("error") },
    )

    /** Stays `running` for [polls] polls, then continues with [then]. */
    fun runningScript(polls: Int, then: List<(RJob) -> Unit> = emptyList()): List<(RJob) -> Unit> =
        List(polls) { i -> { j: RJob -> j.state = RemoteState.RUNNING; j.stage = "dense"; j.stageIndex = 5
            j.stageProgress = i / polls.toDouble(); j.overall = 0.5; j.event("stage_progress") } } + then

    private fun gate() {
        calls++
        if (unreachable) throw CompanionException.unreachable("Companion unreachable (test).")
        if (unauthorized) throw CompanionException(CompanionException.Kind.UNAUTHORIZED, "unauthorized", "bad token", 401)
    }

    private fun notFound(what: String) = api(404, "not_found", "$what not found")

    private fun describe(id: String, s: RSession) = SessionStatus(sessionId = id, name = s.manifest.name,
        totalBytes = s.files.values.sumOf { it.spec.size }, receivedBytes = s.files.values.sumOf { it.received },
        complete = s.files.values.all { it.complete },
        files = s.files.values.map { SessionStatus.FileStatus(it.spec.id, it.spec.size, it.received, it.complete) })

    override suspend fun hello(): HelloResponse {
        calls++
        if (unreachable) throw CompanionException.unreachable("down")
        helloError?.let { throw it }
        return HelloResponse(helloProduct, 1, "1.0.0", serverId, serverName)
    }

    override suspend fun pair(code: String, deviceName: String, deviceId: String?): PairResponse {
        calls++
        if (unreachable) throw CompanionException.unreachable("down")
        pairError?.let { throw it }
        if (!code.equals(pairingCode, ignoreCase = true)) throw api(403, "pairing_failed", "wrong or expired pairing code")
        pairedDeviceIds += deviceId
        return PairResponse("token-${pairedDeviceIds.size}", deviceId ?: "22222222-2222-4222-8222-222222222222", serverId, serverName)
    }

    override suspend fun status(): StatusResponse {
        gate()
        return StatusResponse(version = "1.0.0", serverId = serverId, serverName = serverName)
    }

    override suspend fun putSession(sessionId: String, body: SessionPutRequest): SessionStatus {
        gate()
        putSessionCount++
        putSessionError?.let { throw it }
        delay(stepDelayMs)
        val old = sessions[sessionId]
        val files = LinkedHashMap<String, RFile>()
        for (spec in body.files) {
            val prev = old?.files?.get(spec.id)
            files[spec.id] = if (prev != null && prev.spec.size == spec.size && prev.spec.sha256 == spec.sha256) prev.also { it.spec = spec }
            else RFile(spec)
        }
        val s = RSession(body, files)
        sessions[sessionId] = s
        return describe(sessionId, s)
    }

    override suspend fun getSession(sessionId: String): SessionStatus {
        gate()
        return describe(sessionId, sessions[sessionId] ?: throw notFound("session"))
    }

    override suspend fun deleteSession(sessionId: String): Boolean {
        gate()
        deletedSessions += sessionId
        jobs.values.removeAll { it.body.sessionId == sessionId }
        return sessions.remove(sessionId) != null
    }

    override suspend fun uploadFile(sessionId: String, fileId: String, file: File, size: Long, sha256: String,
                                    startOffset: Long, onProgress: (Long) -> Unit) {
        gate()
        val f = sessions[sessionId]?.files?.get(fileId) ?: throw notFound("file")
        uploadError?.invoke(fileId)?.let { throw it }
        check(file.length() == size) { "local file size differs from the manifest" }
        synchronized(this) {
            uploadsInFlight++
            maxUploadsInFlight = maxOf(maxUploadsInFlight, uploadsInFlight)
            sessionsUploading += sessionId
            maxSessionsUploading = maxOf(maxSessionsUploading, sessionsUploading.size)
        }
        try {
            while (f.received < size) {
                uploadHook?.invoke(fileId, f.received)
                if (unreachable) throw CompanionException.unreachable("Connection lost mid-upload (test).")
                delay(stepDelayMs)
                val n = minOf(uploadChunkBytes, size - f.received)
                f.received += n
                bytesSent.merge(fileId, n) { a, b -> a + b }
                onProgress(f.received)
            }
            if (StorageFiles.sha256(file).sha256 != f.spec.sha256) {
                f.received = 0
                throw api(422, "checksum_mismatch", "SHA-256 mismatch", 0)
            }
            f.complete = true
        } finally {
            synchronized(this) {
                uploadsInFlight--
                if (uploadsInFlight == 0) sessionsUploading.clear()
            }
        }
    }

    override suspend fun submitJob(jobId: String, body: JobSubmitRequest): RemoteJob {
        gate()
        submitCount++
        delay(stepDelayMs)
        jobs[jobId]?.let { existing ->
            if (existing.body != body) throw api(409, "conflict", "a different job with this id already exists")
            return existing.toRemote()
        }
        val s = sessions[body.sessionId] ?: throw notFound("session")
        if (!s.files.values.all { it.complete }) throw api(409, "incomplete_upload", "not all uploaded")
        val job = RJob(jobId, body)
        job.script.addAll(scriptFor(job))
        jobs[jobId] = job
        return job.toRemote()
    }

    override suspend fun pollJob(jobId: String, since: Long, waitSeconds: Int): JobPollResponse {
        gate()
        val job = jobs[jobId] ?: throw notFound("job")
        pollSince += since
        pollHook?.invoke(job)
        if (unreachable) throw CompanionException.unreachable("Connection lost mid-poll (test).")
        delay(if (waitSeconds > 0) 100 else stepDelayMs)
        if (waitSeconds > 0 && job.state !in RemoteState.TERMINAL) job.script.removeFirstOrNull()?.invoke(job)
        val events = job.events.filter { it.seq > since }
        return JobPollResponse(job.toRemote(), events, events.lastOrNull()?.seq ?: job.events.size.toLong())
    }

    override suspend fun cancelJob(jobId: String): RemoteJob {
        gate()
        cancelCount++
        val job = jobs[jobId] ?: throw notFound("job")
        if (job.state !in RemoteState.TERMINAL) { job.state = RemoteState.CANCELLED; job.script.clear(); job.event("log") }
        return job.toRemote()
    }

    override suspend fun retryJob(jobId: String): RemoteJob {
        gate()
        retryCount++
        val job = jobs[jobId] ?: throw notFound("job")
        if (job.state !in setOf(RemoteState.FAILED, RemoteState.CANCELLED, RemoteState.INTERRUPTED)) {
            throw api(409, "conflict", "a job in state ${job.state} cannot be retried")
        }
        job.state = RemoteState.QUEUED; job.attempt++; job.stage = null; job.stageIndex = 0; job.stageProgress = 0.0
        job.overall = 0.0; job.message = ""; job.error = null; job.diagnostics = JsonObject(emptyMap()); job.artifacts.clear()
        job.script.clear(); job.script.addAll(scriptFor(job))
        return job.toRemote()
    }

    override suspend fun deleteJob(jobId: String): Boolean {
        gate()
        deletedJobs += jobId
        return jobs.remove(jobId) != null
    }

    override suspend fun downloadArtifact(jobId: String, artifact: ArtifactInfo, dest: File, onProgress: (Long) -> Unit) {
        gate()
        jobs[jobId] ?: throw notFound("job")
        val bytes = artifactBytes[artifact.name] ?: throw notFound("artifact")
        delay(stepDelayMs)
        downloads += artifact.name
        if (artifact.name == "model.glb" && corruptDownloads > 0) {
            corruptDownloads--
            throw CompanionException(CompanionException.Kind.INTEGRITY, "checksum_mismatch", "model.glb arrived damaged")
        }
        if (bytes.size.toLong() != artifact.size || StorageFiles.sha256(bytes) != artifact.sha256) {
            throw CompanionException(CompanionException.Kind.INTEGRITY, "checksum_mismatch", "${artifact.name} arrived damaged")
        }
        dest.parentFile?.mkdirs()
        dest.writeBytes(bytes)
        onProgress(artifact.size)
    }
}

internal class FakeGateway(var companion: PairedCompanion?) : CompanionGateway {
    var probes = 0
    override fun current(): PairedCompanion? = companion
    override suspend fun probe(): Boolean {
        probes++
        val c = companion ?: return false
        return try { c.api.status(); true } catch (_: CompanionException) { false }
    }
}

internal fun FakeCompanion.paired() = PairedCompanion(serverId, serverName, this)
