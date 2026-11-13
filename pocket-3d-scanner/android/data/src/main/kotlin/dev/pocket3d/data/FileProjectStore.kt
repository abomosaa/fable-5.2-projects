package dev.pocket3d.data

import dev.pocket3d.core.edit.EditDocument
import dev.pocket3d.core.project.CaptureSession
import dev.pocket3d.core.project.CaptureSource
import dev.pocket3d.core.project.DeletionPlan
import dev.pocket3d.core.project.DeviceInfo
import dev.pocket3d.core.project.Frame
import dev.pocket3d.core.project.FrameFlag
import dev.pocket3d.core.project.JobEvent
import dev.pocket3d.core.project.JobPhase
import dev.pocket3d.core.project.JobStateMachine
import dev.pocket3d.core.project.ModelVersion
import dev.pocket3d.core.project.Project
import dev.pocket3d.core.project.ProjectSummary
import dev.pocket3d.core.project.ReconJob
import dev.pocket3d.core.project.ScaleInfo
import dev.pocket3d.core.project.TrackingInfo
import dev.pocket3d.core.services.ProjectStore
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.OutputStream
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** Counts the sync engine extracts from `diagnostics.json` when it registers a downloaded model. */
data class ModelStats(
    val vertexCount: Int = 0,
    val faceCount: Int = 0,
    val textureBytes: Long = 0,
    val registeredCameras: Int = 0,
    val inputFrames: Int = 0,
    val scale: ScaleInfo = ScaleInfo(),
    val settingsFingerprint: String = "",
)

/** `manifest.json` at the top of an exported project archive. */
@Serializable
data class ArchiveManifest(
    val kind: String = KIND,
    val format: Int = FORMAT,
    val exportedAtMs: Long,
    val project: Project,
    val sessions: List<CaptureSession>,
    val models: List<ModelVersion>,
    val files: List<ArchiveFile>,
) {
    companion object {
        const val KIND = "pocket3d-project-archive"
        const val FORMAT = 1
    }
}

@Serializable
data class ArchiveFile(val path: String, val size: Long, val sha256: String)

/**
 * [ProjectStore] on plain files (layout: see `core/project/Model.kt`; additionally each model
 * directory holds `model.json`, the [ModelVersion] record). Pure java.io / kotlinx — no Android.
 *
 * Durability rules:
 *  * every metadata file is replaced atomically (temp → fsync → rename → directory fsync) and the
 *    previous version is kept as `<name>.bak`, which is what [load][FileProjectStore] falls back
 *    to if the current file is missing or does not parse;
 *  * `*.tmp` files are never read and are deleted when the store is opened;
 *  * a photo is moved to its final name *before* `session.json` is rewritten, so a crash can at
 *    worst leave a photo that the metadata does not know — such files are re-adopted on open
 *    (flag `no_metadata`), never deleted;
 *  * a model becomes visible (and active) only by the `project.json` write at the very end of
 *    [registerCompletedModel].
 *
 * Mutations of one project are serialised by a per-project mutex; all work runs on [io].
 * Opening the store scans [root] synchronously.
 */
class FileProjectStore(
    private val root: File,
    private val clock: () -> Long = System::currentTimeMillis,
    private val freeSpace: (File) -> Long = { it.usableSpace },
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : ProjectStore {

    private data class Snapshot(
        val project: Project,
        val sessions: Map<String, CaptureSession>,
        val jobs: Map<String, ReconJob>,
        val models: Map<String, ModelVersion>,
        val diskBytes: Long,
        val summary: ProjectSummary,
    )

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }
    private val state = MutableStateFlow<Map<String, Snapshot>>(emptyMap())
    private val _summaries = MutableStateFlow<List<ProjectSummary>>(emptyList())
    private val locks = ConcurrentHashMap<String, Mutex>()
    private val publishLock = Any()
    private val notes = ArrayList<String>()

    override val summaries: StateFlow<List<ProjectSummary>> = _summaries.asStateFlow()

    /** What had to be repaired when the store was opened (empty after a clean shutdown). */
    val recoveryNotes: List<String> get() = synchronized(notes) { notes.toList() }

    init {
        if (!root.isDirectory && !root.mkdirs() && !root.isDirectory) throw IOException("cannot create project storage")
        val loaded = LinkedHashMap<String, Snapshot>()
        root.listFiles()?.forEach { f ->
            when {
                f.name.startsWith(DELETED_PREFIX) || f.name.startsWith(STAGING_PREFIX) -> StorageFiles.deleteRecursively(f)
                f.isFile && f.name.endsWith(StorageFiles.TMP_SUFFIX) -> f.delete()
                f.isDirectory && Ids.UUID4.matches(f.name) -> loadProject(f)?.let { loaded[f.name] = it }
            }
        }
        synchronized(publishLock) {
            state.value = loaded
            _summaries.value = sortSummaries(loaded.values)
        }
    }

    // =========================================================================================
    // paths (every component is validated; nothing user-supplied is ever used as a name)
    // =========================================================================================
    private fun projectDir(projectId: String) = File(root, Ids.requireUuid(projectId, "project"))
    private fun sessionsDir(projectId: String) = File(projectDir(projectId), "sessions")
    private fun sessionDir(projectId: String, sessionId: String) =
        File(sessionsDir(projectId), Ids.requireUuid(sessionId, "session"))
    private fun framesDir(projectId: String, sessionId: String) = File(sessionDir(projectId, sessionId), "frames")
    private fun modelsDir(projectId: String) = File(projectDir(projectId), "models")

    override fun jobDir(projectId: String, jobId: String): File =
        File(File(projectDir(projectId), "jobs"), Ids.requireUuid(jobId, "job"))

    override fun modelDir(projectId: String, modelId: String): File =
        File(modelsDir(projectId), Ids.requireUuid(modelId, "model"))

    override fun frameFile(projectId: String, sessionId: String, frame: Frame): File {
        require(Ids.FRAME_FILE.matches(frame.file)) { "invalid frame file name" }
        return File(framesDir(projectId, sessionId), frame.file)
    }

    override fun newFrameTempFile(projectId: String, sessionId: String): File {
        val snap = state.value[projectId] ?: throw IllegalArgumentException("unknown project")
        require(snap.sessions.containsKey(sessionId)) { "unknown session" }
        val dir = framesDir(projectId, sessionId)
        dir.mkdirs()
        return File(dir, "incoming-" + Ids.newUuid() + StorageFiles.TMP_SUFFIX)
    }

    // =========================================================================================
    // json helpers
    // =========================================================================================
    private fun <T> encode(serializer: KSerializer<T>, value: T): ByteArray =
        json.encodeToString(serializer, value).toByteArray(Charsets.UTF_8)

    private fun <T> parse(serializer: KSerializer<T>, file: File): T? {
        if (!file.isFile) return null
        return try {
            json.decodeFromString(serializer, file.readText(Charsets.UTF_8))
        } catch (_: Exception) {
            null
        }
    }

    /** Current file, else the last good version. Returns (value, cameFromBackup). */
    private fun <T> readWithBackup(serializer: KSerializer<T>, file: File): Pair<T, Boolean>? {
        parse(serializer, file)?.let { return it to false }
        val bak = File(file.parentFile, file.name + StorageFiles.BAK_SUFFIX)
        parse(serializer, bak)?.let { return it to true }
        return null
    }

    private fun note(text: String) {
        synchronized(notes) { notes += text }
    }

    private fun writeProject(p: Project) =
        StorageFiles.writeAtomic(File(projectDir(p.id), PROJECT_JSON), encode(Project.serializer(), p))

    private fun writeSession(s: CaptureSession) =
        StorageFiles.writeAtomic(File(sessionDir(s.projectId, s.id), SESSION_JSON), encode(CaptureSession.serializer(), s))

    private fun writeJob(j: ReconJob) =
        StorageFiles.writeAtomic(File(jobDir(j.projectId, j.id), JOB_JSON), encode(ReconJob.serializer(), j))

    // =========================================================================================
    // loading + crash recovery
    // =========================================================================================
    private fun cleanTmp(dir: File) {
        dir.listFiles()?.forEach { if (it.isFile && it.name.endsWith(StorageFiles.TMP_SUFFIX)) it.delete() }
    }

    private fun purgeLeftovers(dir: File) {
        dir.listFiles()?.forEach {
            if (it.name.startsWith(DELETED_PREFIX) || it.name.startsWith(STAGING_PREFIX)) StorageFiles.deleteRecursively(it)
            else if (it.isFile && it.name.endsWith(StorageFiles.TMP_SUFFIX)) it.delete()
        }
    }

    private fun uuidDirs(parent: File): List<File> =
        parent.listFiles()?.filter { it.isDirectory && Ids.UUID4.matches(it.name) }?.sortedBy { it.name } ?: emptyList()

    private fun loadProject(dir: File): Snapshot? {
        val id = dir.name
        cleanTmp(dir)
        val sessionsDir = File(dir, "sessions")
        val jobsDir = File(dir, "jobs")
        val modelsDir = File(dir, "models")
        purgeLeftovers(sessionsDir); purgeLeftovers(jobsDir); purgeLeftovers(modelsDir)

        var dirty = false
        val read = readWithBackup(Project.serializer(), File(dir, PROJECT_JSON))
        var project: Project
        if (read == null) {
            if (uuidDirs(sessionsDir).isEmpty() && uuidDirs(modelsDir).isEmpty()) {
                // A project directory that never got its first project.json: nothing was committed.
                StorageFiles.deleteRecursively(dir)
                return null
            }
            note("project $id: project.json was unreadable; rebuilt from its sessions and models")
            project = Project(id = id, name = "Recovered project", createdAtMs = dir.lastModified(), updatedAtMs = clock())
            dirty = true
        } else {
            project = read.first
            if (read.second) {
                note("project $id: project.json was unreadable; restored the previous version")
                dirty = true
            }
            if (project.id != id) { project = project.copy(id = id); dirty = true }
        }

        // ---- sessions ---------------------------------------------------------------------
        val sessions = LinkedHashMap<String, CaptureSession>()
        val sessionDirs = uuidDirs(sessionsDir).associateBy { it.name }
        for (sid in project.sessionIds + sessionDirs.keys.filter { it !in project.sessionIds }) {
            val sdir = sessionDirs[sid] ?: continue
            loadSession(id, sdir)?.let { sessions[sid] = it }
        }

        // ---- jobs -------------------------------------------------------------------------
        val jobs = LinkedHashMap<String, ReconJob>()
        val jobDirs = uuidDirs(jobsDir).associateBy { it.name }
        for (jid in project.jobIds + jobDirs.keys.filter { it !in project.jobIds }) {
            val jdir = jobDirs[jid] ?: continue
            cleanTmp(jdir)
            val r = readWithBackup(ReconJob.serializer(), File(jdir, JOB_JSON))
            if (r == null) {
                note("project $id: job $jid had no readable record and was removed")
                StorageFiles.deleteRecursively(jdir)
                continue
            }
            var job = r.first
            if (job.id != jid || job.projectId != id) job = job.copy(id = jid, projectId = id)
            if (r.second || job !== r.first) {
                StorageFiles.writeAtomic(File(jdir, JOB_JSON), encode(ReconJob.serializer(), job))
            }
            jobs[jid] = job
        }

        // ---- models -----------------------------------------------------------------------
        val models = LinkedHashMap<String, ModelVersion>()
        val modelDirs = uuidDirs(modelsDir).associateBy { it.name }
        var activeModelId = project.activeModelId
        for (mid in project.modelIds + modelDirs.keys.filter { it !in project.modelIds }) {
            val mdir = modelDirs[mid] ?: continue
            cleanTmp(mdir)
            val listed = mid in project.modelIds
            val glb = File(mdir, MODEL_GLB)
            val r = readWithBackup(ModelVersion.serializer(), File(mdir, MODEL_JSON))
            var model = r?.first?.let { if (it.id != mid || it.projectId != id) it.copy(id = mid, projectId = id) else it }
            if (!glb.isFile) {
                if (listed) note("project $id: model $mid lost its model.glb and was removed")
                StorageFiles.deleteRecursively(mdir)
                continue
            }
            if (listed) {
                if (model == null) {
                    val d = StorageFiles.sha256(glb)
                    model = ModelVersion(id = mid, projectId = id, jobId = "", sessionId = "", preset = "",
                        createdAtMs = glb.lastModified(), glbSha256 = d.sha256, glbBytes = d.size, name = "Recovered model")
                    note("project $id: model $mid had no readable record; rebuilt from model.glb")
                }
                if (r == null || r.second || model !== r.first) {
                    StorageFiles.writeAtomic(File(mdir, MODEL_JSON), encode(ModelVersion.serializer(), model))
                }
                models[mid] = model
                continue
            }
            // Not referenced by project.json: the process died inside registerCompletedModel
            // after the model directory was complete (model.json is written last) but before the
            // project record was. Finish that registration if its job is still waiting for it.
            val job = model?.let { jobs[it.jobId] }
            if (model != null && job != null && job.phase == JobPhase.DOWNLOADING) {
                models[mid] = model
                activeModelId = mid
                note("project $id: finished registering model $mid after an interrupted save")
            } else {
                StorageFiles.deleteRecursively(mdir)
            }
        }
        if (activeModelId != null && activeModelId !in models) {
            note("project $id: its active model is gone; switched to the newest remaining model")
            activeModelId = models.values.maxByOrNull { it.createdAtMs }?.id
        }

        // A job whose model is registered is complete (replays the end of registerCompletedModel).
        for ((jid, job) in jobs.entries.toList()) {
            if (job.phase != JobPhase.DOWNLOADING) continue
            val model = models.values.firstOrNull { it.jobId == jid } ?: continue
            val done = job.copy(phase = JobStateMachine.transition(job.phase, JobEvent.ResultsVerified),
                modelId = model.id, overallProgress = 1f, waitingReason = null,
                finishedAtMs = job.finishedAtMs ?: clock(), updatedAtMs = clock())
            StorageFiles.writeAtomic(File(jobDirs.getValue(jid), JOB_JSON), encode(ReconJob.serializer(), done))
            jobs[jid] = done
        }

        val latestSession = sessions.values.maxOfOrNull { it.updatedAtMs } ?: 0L
        val fixed = project.copy(
            sessionIds = sessions.keys.toList(), jobIds = jobs.keys.toList(), modelIds = models.keys.toList(),
            activeModelId = activeModelId, updatedAtMs = maxOf(project.updatedAtMs, latestSession))
        if (dirty || fixed.copy(updatedAtMs = project.updatedAtMs) != project) {
            StorageFiles.writeAtomic(File(dir, PROJECT_JSON), encode(Project.serializer(), fixed))
        }
        return snapshot(fixed, sessions, jobs, models, StorageFiles.dirSize(dir))
    }

    private fun loadSession(projectId: String, dir: File): CaptureSession? {
        val sid = dir.name
        cleanTmp(dir)
        val framesDir = File(dir, "frames")
        cleanTmp(framesDir)   // photos that were never committed
        val onDisk = LinkedHashMap<String, File>()
        framesDir.listFiles()?.sortedBy { it.name }?.forEach { if (it.isFile && Ids.FRAME_FILE.matches(it.name)) onDisk[it.name] = it }

        var dirty = false
        val read = readWithBackup(CaptureSession.serializer(), File(dir, SESSION_JSON))
        var session: CaptureSession
        if (read == null) {
            if (onDisk.isEmpty()) {
                StorageFiles.deleteRecursively(dir)   // createSession never completed
                return null
            }
            note("session $sid: session.json was unreadable; its ${onDisk.size} photos were kept without metadata")
            session = CaptureSession(id = sid, projectId = projectId, createdAtMs = dir.lastModified(),
                updatedAtMs = clock(), source = CaptureSource.IMPORT)
            dirty = true
        } else {
            session = read.first
            if (read.second) {
                note("session $sid: session.json was unreadable; restored the previous version")
                dirty = true
            }
            if (session.id != sid || session.projectId != projectId) {
                session = session.copy(id = sid, projectId = projectId); dirty = true
            }
        }

        val kept = ArrayList<Frame>(session.frames.size)
        val seenIds = HashSet<String>()
        val claimed = HashSet<String>()
        for (f in session.frames) {
            val ok = Ids.FRAME_ID.matches(f.id) && f.file in onDisk && f.file.substringBeforeLast('.') == f.id && seenIds.add(f.id)
            if (ok) { kept += f; claimed += f.file } else {
                note("session $sid: photo ${f.id} has no file on disk any more and was dropped from the session")
                dirty = true
            }
        }
        for ((name, file) in onDisk) {
            if (name in claimed) continue
            val m = Ids.FRAME_FILE.matchEntire(name) ?: continue
            val frameId = m.groupValues[1]
            if (!seenIds.add(frameId)) continue   // same id under another extension: leave the file alone
            val d = StorageFiles.sha256(file)
            if (d.size == 0L) { file.delete(); continue }
            kept += Frame(id = frameId, name = name, file = name, sizeBytes = d.size, sha256 = d.sha256,
                format = Ids.formatForExtension(m.groupValues[2]), flags = listOf(FrameFlag.NO_METADATA))
            note("session $sid: photo $name was on disk but not in session.json; re-adopted without metadata")
            dirty = true
        }
        if (dirty) {
            session = session.copy(frames = kept, updatedAtMs = clock())
            StorageFiles.writeAtomic(File(dir, SESSION_JSON), encode(CaptureSession.serializer(), session))
        }
        return session
    }

    // =========================================================================================
    // snapshots
    // =========================================================================================
    private fun snapshot(project: Project, sessions: Map<String, CaptureSession>, jobs: Map<String, ReconJob>,
                         models: Map<String, ModelVersion>, diskBytes: Long): Snapshot {
        val latest = jobs.values.fold(null as ReconJob?) { best, j -> if (best == null || j.createdAtMs >= best.createdAtMs) j else best }
        val progress = when (latest?.phase) {
            null -> 0f
            JobPhase.UPLOADING -> if (latest.totalBytes > 0) (latest.uploadedBytes.toFloat() / latest.totalBytes).coerceIn(0f, 1f) else 0f
            JobPhase.DOWNLOADING, JobPhase.COMPLETED -> 1f
            else -> latest.overallProgress.coerceIn(0f, 1f)
        }
        val thumb = project.activeModelId?.takeIf { it in models }
            ?.let { File(modelDir(project.id, it), THUMBNAIL) }?.takeIf { it.isFile }?.absolutePath
        val summary = ProjectSummary(
            project = project,
            frameCount = sessions.values.sumOf { s -> s.frames.count { !it.excluded } },
            diskBytes = diskBytes,
            thumbnailPath = thumb,
            latestJobPhase = latest?.phase,
            latestJobProgress = progress,
            hasModel = project.activeModelId != null && project.activeModelId in models,
        )
        return Snapshot(project, sessions, jobs, models, diskBytes, summary)
    }

    private fun sortSummaries(snaps: Collection<Snapshot>): List<ProjectSummary> =
        snaps.map { it.summary }.sortedWith(
            compareByDescending<ProjectSummary> { it.project.updatedAtMs }
                .thenByDescending { it.project.createdAtMs }.thenBy { it.project.id })

    private fun publish(projectId: String, snap: Snapshot?) {
        synchronized(publishLock) {
            val next = if (snap == null) state.value - projectId else state.value + (projectId to snap)
            state.value = next
            _summaries.value = sortSummaries(next.values)
        }
    }

    private fun Snapshot.copyWith(project: Project = this.project, sessions: Map<String, CaptureSession> = this.sessions,
                              jobs: Map<String, ReconJob> = this.jobs, models: Map<String, ModelVersion> = this.models,
                              diskBytes: Long = this.diskBytes): Snapshot =
        snapshot(project, sessions, jobs, models, diskBytes)

    private fun measured(projectId: String): Long = StorageFiles.dirSize(projectDir(projectId))

    private fun snap(projectId: String): Snapshot =
        state.value[projectId] ?: throw IllegalArgumentException("unknown project")

    private suspend fun <T> locked(projectId: String, block: () -> T): T {
        Ids.requireUuid(projectId, "project")
        return withContext(io) { locks.getOrPut(projectId) { Mutex() }.withLock { block() } }
    }

    /** @throws InsufficientStorageException if fewer than [requiredBytes] + 50 MB are free. */
    fun requireFreeSpace(requiredBytes: Long) {
        val free = freeSpace(root)
        if (free < requiredBytes + RESERVE_BYTES) throw InsufficientStorageException(requiredBytes, free)
    }

    override suspend fun freeBytes(): Long = withContext(io) { freeSpace(root) }

    // =========================================================================================
    // projects
    // =========================================================================================
    override suspend fun createProject(name: String): Project {
        val id = Ids.newUuid()
        return locked(id) {
            val now = clock()
            val project = Project(id = id, name = cleanName(name), createdAtMs = now, updatedAtMs = now)
            val dir = projectDir(id)
            if (!dir.mkdirs()) throw IOException("cannot create project directory")
            writeProject(project)
            StorageFiles.fsyncDir(root)
            publish(id, snapshot(project, emptyMap(), emptyMap(), emptyMap(), measured(id)))
            project
        }
    }

    override suspend fun project(projectId: String): Project? = state.value[projectId]?.project

    override fun observeProject(projectId: String): Flow<Project?> =
        state.map { it[projectId]?.project }.distinctUntilChanged()

    override suspend fun renameProject(projectId: String, name: String) = locked(projectId) {
        val s = snap(projectId)
        val p = s.project.copy(name = cleanName(name), updatedAtMs = clock())
        writeProject(p)
        publish(projectId, s.copyWith(project = p))
    }

    override suspend fun duplicateProject(projectId: String): Project = locked(projectId) {
        val s = snap(projectId)
        val srcDir = projectDir(projectId)
        val required = s.sessions.values.sumOf { ses -> ses.frames.sumOf { it.sizeBytes } } +
            s.models.keys.sumOf { StorageFiles.dirSize(modelDir(projectId, it)) }
        requireFreeSpace(required)

        val newId = Ids.newUuid()
        val staging = File(root, STAGING_PREFIX + newId)
        try {
            if (!staging.mkdirs()) throw IOException("cannot create staging directory")
            val now = clock()
            val sessionMap = s.sessions.keys.associateWith { Ids.newUuid() }
            val modelMap = s.models.keys.associateWith { Ids.newUuid() }
            val newSessions = LinkedHashMap<String, CaptureSession>()
            for ((oldId, ses) in s.sessions) {
                val nid = sessionMap.getValue(oldId)
                val dstFrames = File(File(File(staging, "sessions"), nid), "frames")
                if (!dstFrames.mkdirs()) throw IOException("cannot create session directory")
                val srcFrames = File(File(File(srcDir, "sessions"), oldId), "frames")
                for (f in ses.frames) {
                    require(Ids.FRAME_FILE.matches(f.file)) { "invalid frame file name" }
                    StorageFiles.copyFile(File(srcFrames, f.file), File(dstFrames, f.file))
                }
                StorageFiles.fsyncDir(dstFrames)
                val copy = ses.copy(id = nid, projectId = newId, updatedAtMs = now)
                StorageFiles.writeAtomic(File(dstFrames.parentFile, SESSION_JSON), encode(CaptureSession.serializer(), copy), keepBackup = false)
                newSessions[nid] = copy
            }
            val newModels = LinkedHashMap<String, ModelVersion>()
            for ((oldId, m) in s.models) {
                val nid = modelMap.getValue(oldId)
                val dst = File(File(staging, "models"), nid)
                if (!dst.mkdirs()) throw IOException("cannot create model directory")
                for (name in MODEL_FILES) {
                    val src = File(File(File(srcDir, "models"), oldId), name)
                    if (src.isFile) StorageFiles.copyFile(src, File(dst, name))
                }
                val copy = m.copy(id = nid, projectId = newId, sessionId = sessionMap[m.sessionId] ?: m.sessionId)
                StorageFiles.writeAtomic(File(dst, MODEL_JSON), encode(ModelVersion.serializer(), copy), keepBackup = false)
                newModels[nid] = copy
            }
            val project = Project(id = newId, name = cleanName(s.project.name + " copy"), createdAtMs = now, updatedAtMs = now,
                sessionIds = newSessions.keys.toList(), modelIds = newModels.keys.toList(),
                activeModelId = s.project.activeModelId?.let { modelMap[it] })
            StorageFiles.writeAtomic(File(staging, PROJECT_JSON), encode(Project.serializer(), project), keepBackup = false)
            // The rename is the commit: before it the copy does not exist (and is purged on open).
            StorageFiles.moveAtomic(staging, File(root, newId))
            StorageFiles.fsyncDir(root)
            publish(newId, snapshot(project, newSessions, emptyMap(), newModels, measured(newId)))
            project
        } finally {
            if (staging.exists()) StorageFiles.deleteRecursively(staging)
        }
    }

    override suspend fun deletionPlan(projectId: String): DeletionPlan = locked(projectId) {
        val s = snap(projectId)
        val frames = s.sessions.values.flatMap { it.frames }
        DeletionPlan(
            projectName = s.project.name,
            photoCount = frames.size,
            photoBytes = frames.sumOf { it.sizeBytes },
            modelCount = s.models.size,
            modelBytes = s.models.keys.sumOf { StorageFiles.dirSize(modelDir(projectId, it)) },
            totalBytes = measured(projectId),
            companionSessionIds = emptyList(), companionName = null, companionReachable = false,
        )
    }

    override suspend fun deleteProject(projectId: String) = locked(projectId) {
        if (state.value[projectId] == null) return@locked
        val dir = projectDir(projectId)
        val trash = File(root, DELETED_PREFIX + projectId + "-" + java.lang.Long.toHexString(System.nanoTime()))
        // One rename makes the whole project disappear; the bytes are removed afterwards (and
        // on the next open if the process dies in between).
        StorageFiles.moveAtomic(dir, trash)
        StorageFiles.fsyncDir(root)
        publish(projectId, null)
        StorageFiles.deleteRecursively(trash)
    }

    /**
     * Zip layout: `manifest.json` ([ArchiveManifest]) first, then `project.json`,
     * `sessions/<id>/session.json`, `sessions/<id>/frames/<file>`, `models/<id>/…`. Paths are
     * relative, photos and models are stored uncompressed. [out] is flushed but not closed.
     */
    override suspend fun exportProjectArchive(projectId: String, out: OutputStream, onProgress: (Float) -> Unit) =
        locked(projectId) {
            val s = snap(projectId)
            val dir = projectDir(projectId)
            val paths = ArrayList<String>()
            paths += PROJECT_JSON
            for ((sid, ses) in s.sessions) {
                paths += "sessions/$sid/$SESSION_JSON"
                for (f in ses.frames) {
                    require(Ids.FRAME_FILE.matches(f.file)) { "invalid frame file name" }
                    paths += "sessions/$sid/frames/${f.file}"
                }
            }
            for (mid in s.models.keys) {
                paths += "models/$mid/$MODEL_JSON"
                for (name in MODEL_FILES) if (File(modelDir(projectId, mid), name).isFile) paths += "models/$mid/$name"
            }
            val sizes = paths.associateWith { File(dir, it).length() }
            val total = sizes.values.sum()
            requireFreeSpace(total)

            // Pass 1: checksums for the manifest (and CRCs, which stored zip entries need up front).
            var done = 0L
            val work = (2 * total).coerceAtLeast(1)
            val buf = ByteArray(256 * 1024)
            val entries = ArrayList<ArchiveFile>(paths.size)
            val crcs = HashMap<String, Long>()
            for (path in paths) {
                val md = MessageDigest.getInstance("SHA-256")
                val crc = CRC32()
                var size = 0L
                FileInputStream(File(dir, path)).use { input ->
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        md.update(buf, 0, n); crc.update(buf, 0, n); size += n
                        done += n
                        onProgress(done.toFloat() / work)
                    }
                }
                entries += ArchiveFile(path, size, StorageFiles.hex(md.digest()))
                crcs[path] = crc.value
            }
            val manifest = ArchiveManifest(exportedAtMs = clock(), project = s.project.copy(jobIds = emptyList()),
                sessions = s.sessions.values.toList(), models = s.models.values.toList(), files = entries)

            val zip = ZipOutputStream(out)
            zip.putNextEntry(ZipEntry("manifest.json"))
            zip.write(encode(ArchiveManifest.serializer(), manifest))
            zip.closeEntry()
            for (e in entries) {
                val entry = ZipEntry(e.path)
                if (!e.path.endsWith(".json")) {
                    entry.method = ZipEntry.STORED
                    entry.size = e.size
                    entry.compressedSize = e.size
                    entry.crc = crcs.getValue(e.path)
                }
                zip.putNextEntry(entry)
                var written = 0L
                FileInputStream(File(dir, e.path)).use { input ->
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        zip.write(buf, 0, n)
                        written += n; done += n
                        onProgress((done.toFloat() / work).coerceAtMost(1f))
                    }
                }
                if (written != e.size) throw IOException("${e.path} changed during the export")
                zip.closeEntry()
            }
            zip.finish()
            out.flush()
            onProgress(1f)
        }

    // =========================================================================================
    // capture sessions
    // =========================================================================================
    override suspend fun createSession(projectId: String, source: CaptureSource, device: DeviceInfo): CaptureSession =
        locked(projectId) {
            val s = snap(projectId)
            val now = clock()
            val session = CaptureSession(id = Ids.newUuid(), projectId = projectId, createdAtMs = now, updatedAtMs = now,
                source = source, device = device)
            if (!framesDir(projectId, session.id).mkdirs()) throw IOException("cannot create session directory")
            writeSession(session)
            val p = s.project.copy(sessionIds = s.project.sessionIds + session.id, updatedAtMs = now)
            writeProject(p)
            publish(projectId, s.copyWith(project = p, sessions = s.sessions + (session.id to session), diskBytes = measured(projectId)))
            session
        }

    override suspend fun session(projectId: String, sessionId: String): CaptureSession? =
        state.value[projectId]?.sessions?.get(sessionId)

    override fun observeSession(projectId: String, sessionId: String): Flow<CaptureSession?> =
        state.map { it[projectId]?.sessions?.get(sessionId) }.distinctUntilChanged()

    override suspend fun sessions(projectId: String): List<CaptureSession> =
        state.value[projectId]?.sessions?.values?.toList() ?: emptyList()

    override suspend fun commitFrame(projectId: String, sessionId: String, frame: Frame, tempFile: File): Frame =
        locked(projectId) {
            val s = snap(projectId)
            val session = s.sessions[sessionId] ?: throw IllegalArgumentException("unknown session")
            Ids.requireFrameId(frame.id)
            val ext = Ids.extensionFor(frame.format)
            require(session.frames.none { it.id == frame.id }) { "frame id is already used in this session" }
            val dir = framesDir(projectId, sessionId)
            require(tempFile.isFile && tempFile.name.endsWith(StorageFiles.TMP_SUFFIX) &&
                tempFile.absoluteFile.parentFile?.canonicalFile == dir.canonicalFile) {
                "tempFile must be a file obtained from newFrameTempFile"
            }
            val free = freeSpace(root)
            if (free < COMMIT_OVERHEAD_BYTES + RESERVE_BYTES) {
                tempFile.delete()   // free the space; the photo was never committed
                throw InsufficientStorageException(COMMIT_OVERHEAD_BYTES, free)
            }
            val digest = StorageFiles.sha256(tempFile)
            require(digest.size > 0) { "the photo file is empty" }
            StorageFiles.fsyncFile(tempFile)
            val name = frame.id + "." + ext
            val target = File(dir, name)
            check(!target.exists()) { "a photo file with this id already exists" }
            StorageFiles.moveAtomic(tempFile, target)
            StorageFiles.fsyncDir(dir)
            val now = clock()
            val stored = frame.copy(file = name, sizeBytes = digest.size, sha256 = digest.sha256)
            val next = session.copy(frames = session.frames + stored, updatedAtMs = now)
            writeSession(next)
            publish(projectId, s.copyWith(project = s.project.copy(updatedAtMs = maxOf(now, s.project.updatedAtMs)),
                sessions = s.sessions + (sessionId to next), diskBytes = s.diskBytes + digest.size))
            stored
        }

    private fun Snapshot.withSession(session: CaptureSession, diskBytes: Long = this.diskBytes): Snapshot =
        copyWith(project = project.copy(updatedAtMs = maxOf(session.updatedAtMs, project.updatedAtMs)),
            sessions = sessions + (session.id to session), diskBytes = diskBytes)

    override suspend fun updateFrame(projectId: String, sessionId: String, frameId: String, transform: (Frame) -> Frame) =
        locked(projectId) {
            val s = snap(projectId)
            val session = s.sessions[sessionId] ?: throw IllegalArgumentException("unknown session")
            val old = session.frames.firstOrNull { it.id == frameId } ?: return@locked
            // Identity and the facts about the stored bytes are not the caller's to change.
            val new = transform(old).copy(id = old.id, file = old.file, sizeBytes = old.sizeBytes, sha256 = old.sha256,
                format = old.format)
            if (new == old) return@locked
            val next = session.copy(frames = session.frames.map { if (it.id == frameId) new else it }, updatedAtMs = clock())
            writeSession(next)
            publish(projectId, s.withSession(next))
        }

    override suspend fun removeFrame(projectId: String, sessionId: String, frameId: String) = locked(projectId) {
        val s = snap(projectId)
        val session = s.sessions[sessionId] ?: throw IllegalArgumentException("unknown session")
        val old = session.frames.firstOrNull { it.id == frameId } ?: return@locked
        // File first: if the process dies in between, the next open drops the metadata of the
        // missing file — whereas a file without metadata would come back as a re-adopted photo.
        val file = frameFile(projectId, sessionId, old)
        if (file.exists() && !file.delete()) throw IOException("cannot delete the photo file")
        StorageFiles.fsyncDir(file.parentFile!!)
        val next = session.copy(frames = session.frames.filter { it.id != frameId },
            tracking = session.tracking.copy(segments = session.tracking.segments.map { seg -> seg.copy(frames = seg.frames - frameId) }),
            updatedAtMs = clock())
        writeSession(next)
        publish(projectId, s.withSession(next, measured(projectId)))
    }

    override suspend fun reorderFrames(projectId: String, sessionId: String, orderedIds: List<String>, ordering: String) =
        locked(projectId) {
            require(ordering in ORDERINGS) { "ordering must be one of $ORDERINGS" }
            val s = snap(projectId)
            val session = s.sessions[sessionId] ?: throw IllegalArgumentException("unknown session")
            val byId = session.frames.associateBy { it.id }
            val first = orderedIds.distinct().mapNotNull { byId[it] }
            val listed = first.mapTo(HashSet()) { it.id }
            // Frames the caller did not mention keep their relative order at the end — never dropped.
            val frames = first + session.frames.filter { it.id !in listed }
            val next = session.copy(frames = frames, ordering = ordering, updatedAtMs = clock())
            writeSession(next)
            publish(projectId, s.withSession(next))
        }

    /** A `null` argument leaves that part of the session unchanged. */
    override suspend fun updateSessionMeta(projectId: String, sessionId: String, tracking: TrackingInfo?,
                                           objectCenterAr: List<Double>?) = locked(projectId) {
        val s = snap(projectId)
        val session = s.sessions[sessionId] ?: throw IllegalArgumentException("unknown session")
        require(objectCenterAr == null || (objectCenterAr.size == 3 && objectCenterAr.all { it.isFinite() })) {
            "objectCenterAr must be three finite numbers"
        }
        val next = session.copy(tracking = tracking ?: session.tracking,
            objectCenterAr = objectCenterAr ?: session.objectCenterAr, updatedAtMs = clock())
        writeSession(next)
        publish(projectId, s.withSession(next))
    }

    override suspend fun deleteSession(projectId: String, sessionId: String) = locked(projectId) {
        val s = snap(projectId)
        if (sessionId !in s.sessions) return@locked
        val dir = sessionDir(projectId, sessionId)
        val trash = File(dir.parentFile, DELETED_PREFIX + sessionId + "-" + java.lang.Long.toHexString(System.nanoTime()))
        StorageFiles.moveAtomic(dir, trash)
        StorageFiles.fsyncDir(dir.parentFile!!)
        val p = s.project.copy(sessionIds = s.project.sessionIds - sessionId, updatedAtMs = clock())
        writeProject(p)
        StorageFiles.deleteRecursively(trash)
        publish(projectId, s.copyWith(project = p, sessions = s.sessions - sessionId, diskBytes = measured(projectId)))
    }

    // =========================================================================================
    // jobs (read side of ProjectStore + the mutation API used by the sync engine)
    // =========================================================================================
    override suspend fun job(projectId: String, jobId: String): ReconJob? = state.value[projectId]?.jobs?.get(jobId)

    override fun observeJob(projectId: String, jobId: String): Flow<ReconJob?> =
        state.map { it[projectId]?.jobs?.get(jobId) }.distinctUntilChanged()

    override suspend fun jobs(projectId: String): List<ReconJob> =
        state.value[projectId]?.jobs?.values?.toList() ?: emptyList()

    /** Every job of every project (used to resume supervision after a restart). */
    fun allJobs(): List<ReconJob> = state.value.values.flatMap { it.jobs.values }

    /** Creates a durable PENDING job. Its id is a UUIDv4 and doubles as the companion's job id. */
    suspend fun createJob(projectId: String, sessionId: String, preset: String, frameIds: List<String>,
                          totalBytes: Long, companionId: String?, companionName: String?,
                          settings: JsonObject = JsonObject(emptyMap())): ReconJob = locked(projectId) {
        val s = snap(projectId)
        require(sessionId in s.sessions) { "unknown session" }
        val now = clock()
        val job = ReconJob(id = Ids.newUuid(), projectId = projectId, sessionId = sessionId, preset = preset,
            settings = settings, frameIds = frameIds, createdAtMs = now, updatedAtMs = now,
            companionId = companionId, companionName = companionName, totalBytes = totalBytes)
        if (!jobDir(projectId, job.id).mkdirs()) throw IOException("cannot create job directory")
        writeJob(job)
        val p = s.project.copy(jobIds = s.project.jobIds + job.id)
        writeProject(p)
        publish(projectId, s.copyWith(project = p, jobs = s.jobs + (job.id to job)))
        job
    }

    /**
     * Atomically rewrites a job record. The phase is never taken from [transform]: it is
     * `JobStateMachine.transition(current, event)` (unchanged when [event] is null), so every
     * phase change in the app goes through the state machine. [transform] receives the job with
     * the new phase and whether the phase changed. Returns the stored job, or null if it is gone.
     */
    suspend fun updateJob(projectId: String, jobId: String, event: JobEvent? = null,
                          transform: (job: ReconJob, phaseChanged: Boolean) -> ReconJob = { j, _ -> j }): ReconJob? =
        locked(projectId) {
            val s = state.value[projectId] ?: return@locked null
            val old = s.jobs[jobId] ?: return@locked null
            val phase = if (event == null) old.phase else JobStateMachine.transition(old.phase, event)
            val new = transform(old.copy(phase = phase), phase != old.phase)
                .copy(id = old.id, projectId = old.projectId, phase = phase)
            if (new == old) return@locked old
            val stamped = new.copy(updatedAtMs = clock())
            writeJob(stamped)
            publish(projectId, s.copyWith(jobs = s.jobs + (jobId to stamped)))
            stamped
        }

    /** Removes the job record and its directory. A model created by the job is kept. */
    suspend fun deleteJobRecord(projectId: String, jobId: String) = locked(projectId) {
        val s = state.value[projectId] ?: return@locked
        if (jobId !in s.jobs) return@locked
        val p = s.project.copy(jobIds = s.project.jobIds - jobId)
        writeProject(p)
        StorageFiles.deleteRecursively(jobDir(projectId, jobId))
        publish(projectId, s.copyWith(project = p, jobs = s.jobs - jobId, diskBytes = measured(projectId)))
    }

    /**
     * The one place a reconstruction result becomes a model. [files] maps artifact names
     * (`model.glb` required; `cameras.json`, `diagnostics.json`) to downloaded, verified files,
     * which are moved into the new model directory. Only here — after the GLB's size and SHA-256
     * were checked once more — is `activeModelId` switched and the job moved to COMPLETED
     * (via [JobEvent.ResultsVerified]). Until this returns the previous model stays active.
     *
     * @throws IllegalStateException if the job is not DOWNLOADING (e.g. it was cancelled)
     * @throws IOException if the GLB does not match [glbSha256] / [glbBytes]
     */
    suspend fun registerCompletedModel(projectId: String, jobId: String, files: Map<String, File>,
                                       glbSha256: String, glbBytes: Long, stats: ModelStats): ModelVersion =
        locked(projectId) {
            val s = snap(projectId)
            val job = s.jobs[jobId] ?: throw IllegalStateException("the job no longer exists")
            s.models.values.firstOrNull { it.jobId == jobId }?.let { existing ->
                // Replay after a crash: the model is already registered, only the job record lags.
                finishJob(s, job, existing.id)
                return@locked existing
            }
            check(job.phase == JobPhase.DOWNLOADING) { "job is ${job.phase}, not DOWNLOADING" }
            val glb = files[MODEL_GLB] ?: throw IOException("the result contains no model.glb")
            val digest = StorageFiles.sha256(glb)
            if (digest.size != glbBytes || !digest.sha256.equals(glbSha256, ignoreCase = true)) {
                throw IOException("model.glb does not match the checksum announced by the companion")
            }
            val now = clock()
            val modelId = Ids.newUuid()
            val models = modelsDir(projectId)
            val staging = File(models, STAGING_PREFIX + modelId)
            if (!staging.mkdirs()) throw IOException("cannot create model directory")
            val model = ModelVersion(id = modelId, projectId = projectId, jobId = jobId, sessionId = job.sessionId,
                preset = job.preset, settingsFingerprint = stats.settingsFingerprint, createdAtMs = now,
                glbSha256 = digest.sha256, glbBytes = digest.size, vertexCount = stats.vertexCount,
                faceCount = stats.faceCount, textureBytes = stats.textureBytes,
                registeredCameras = stats.registeredCameras, inputFrames = stats.inputFrames,
                reconstructionScale = stats.scale, name = "Model ${s.project.modelIds.size + 1}")
            try {
                for (name in RESULT_FILES) {
                    val src = files[name] ?: continue
                    StorageFiles.fsyncFile(src)
                    StorageFiles.moveAtomic(src, File(staging, name))
                }
                // model.json last: its presence means the directory is complete.
                StorageFiles.writeAtomic(File(staging, MODEL_JSON), encode(ModelVersion.serializer(), model), keepBackup = false)
                StorageFiles.moveAtomic(staging, File(models, modelId))
                StorageFiles.fsyncDir(models)
            } catch (e: Exception) {
                StorageFiles.deleteRecursively(staging)
                throw e
            }
            val p = s.project.copy(modelIds = s.project.modelIds + modelId, activeModelId = modelId, updatedAtMs = now)
            writeProject(p)   // commit point
            val withModel = s.copyWith(project = p, models = s.models + (modelId to model), diskBytes = measured(projectId))
            publish(projectId, withModel)
            finishJob(withModel, job, modelId)
            model
        }

    private fun finishJob(s: Snapshot, job: ReconJob, modelId: String) {
        val phase = JobStateMachine.transition(job.phase, JobEvent.ResultsVerified)
        if (phase == job.phase && job.modelId == modelId) return
        val now = clock()
        val done = job.copy(phase = phase, modelId = if (phase == JobPhase.COMPLETED) modelId else job.modelId,
            overallProgress = if (phase == JobPhase.COMPLETED) 1f else job.overallProgress, waitingReason = null,
            finishedAtMs = job.finishedAtMs ?: now, updatedAtMs = now)
        writeJob(done)
        publish(job.projectId, s.copyWith(jobs = s.jobs + (job.id to done)))
    }

    // =========================================================================================
    // models
    // =========================================================================================
    override suspend fun model(projectId: String, modelId: String): ModelVersion? =
        state.value[projectId]?.models?.get(modelId)

    override suspend fun models(projectId: String): List<ModelVersion> =
        state.value[projectId]?.models?.values?.toList() ?: emptyList()

    override suspend fun setActiveModel(projectId: String, modelId: String) = locked(projectId) {
        val s = snap(projectId)
        require(modelId in s.models) { "unknown model" }
        if (s.project.activeModelId == modelId) return@locked
        val p = s.project.copy(activeModelId = modelId, updatedAtMs = clock())
        writeProject(p)
        publish(projectId, s.copyWith(project = p))
    }

    override suspend fun deleteModel(projectId: String, modelId: String) = locked(projectId) {
        val s = snap(projectId)
        if (modelId !in s.models) return@locked
        val remaining = s.models - modelId
        val active = if (s.project.activeModelId == modelId) remaining.values.maxByOrNull { it.createdAtMs }?.id
        else s.project.activeModelId
        val p = s.project.copy(modelIds = s.project.modelIds - modelId, activeModelId = active, updatedAtMs = clock())
        writeProject(p)   // commit; an unreferenced model directory is removed on the next open
        StorageFiles.deleteRecursively(modelDir(projectId, modelId))
        publish(projectId, s.copyWith(project = p, models = remaining, diskBytes = measured(projectId)))
    }

    override suspend fun loadEdits(projectId: String, modelId: String): EditDocument = withContext(io) {
        val model = state.value[projectId]?.models?.get(modelId) ?: throw IllegalArgumentException("unknown model")
        val fresh = EditDocument(baseSha256 = model.glbSha256)
        val file = File(modelDir(projectId, modelId), EDITS_JSON)
        val doc = readWithBackup(EditDocument.serializer(), file)?.first ?: return@withContext fresh
        // Edits are tied to one exact GLB; anything else is never applied.
        if (doc.baseSha256 == model.glbSha256) doc else fresh
    }

    override suspend fun saveEdits(projectId: String, modelId: String, edits: EditDocument) = locked(projectId) {
        val s = snap(projectId)
        val model = s.models[modelId] ?: throw IllegalArgumentException("unknown model")
        require(edits.baseSha256 == model.glbSha256) { "these edits belong to a different model" }
        StorageFiles.writeAtomic(File(modelDir(projectId, modelId), EDITS_JSON), encode(EditDocument.serializer(), edits))
        publish(projectId, s.copyWith(diskBytes = measured(projectId)))
    }

    override suspend fun saveThumbnail(projectId: String, modelId: String, png: ByteArray) = locked(projectId) {
        val s = snap(projectId)
        require(modelId in s.models) { "unknown model" }
        require(png.size >= 8 && png[0] == 0x89.toByte() && png[1] == 'P'.code.toByte() && png[2] == 'N'.code.toByte() &&
            png[3] == 'G'.code.toByte()) { "thumbnail must be a PNG" }
        requireFreeSpace(png.size.toLong())
        StorageFiles.writeAtomic(File(modelDir(projectId, modelId), THUMBNAIL), png, keepBackup = false)
        // Same path, new picture: bump the project so the library row is re-emitted.
        val p = s.project.copy(updatedAtMs = clock())
        writeProject(p)
        publish(projectId, s.copyWith(project = p, diskBytes = measured(projectId)))
    }

    private fun cleanName(name: String): String {
        val cleaned = name.filter { !it.isISOControl() }.trim().take(MAX_NAME_CHARS)
        return cleaned.ifEmpty { "Untitled scan" }
    }

    companion object {
        /** Free space that is never used up by photos, copies or exports. */
        const val RESERVE_BYTES = 50L * 1024 * 1024
        /** Metadata a frame commit still has to write (the photo bytes are already on disk). */
        const val COMMIT_OVERHEAD_BYTES = 1L * 1024 * 1024
        /** The companion accepts session names of at most 200 characters. */
        const val MAX_NAME_CHARS = 120

        internal const val PROJECT_JSON = "project.json"
        internal const val SESSION_JSON = "session.json"
        internal const val JOB_JSON = "job.json"
        internal const val MODEL_JSON = "model.json"
        internal const val MODEL_GLB = "model.glb"
        internal const val EDITS_JSON = "edits.json"
        internal const val THUMBNAIL = "thumbnail.png"
        internal const val DELETED_PREFIX = ".deleted-"
        internal const val STAGING_PREFIX = ".staging-"
        /** Artifacts that make up a model, as delivered by the companion. */
        internal val RESULT_FILES = listOf(MODEL_GLB, "cameras.json", "diagnostics.json")
        /** Everything in a model directory that is copied / exported (model.json is handled separately). */
        internal val MODEL_FILES = RESULT_FILES + listOf(EDITS_JSON, THUMBNAIL)
        private val ORDERINGS = setOf("name", "time", "manual")
    }
}
