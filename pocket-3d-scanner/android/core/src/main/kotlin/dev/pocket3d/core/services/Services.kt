package dev.pocket3d.core.services

import dev.pocket3d.core.edit.EditDocument
import dev.pocket3d.core.net.PairingInfo
import dev.pocket3d.core.net.StatusResponse
import dev.pocket3d.core.project.CaptureSession
import dev.pocket3d.core.project.CaptureSource
import dev.pocket3d.core.project.DeletionPlan
import dev.pocket3d.core.project.DeviceInfo
import dev.pocket3d.core.project.Frame
import dev.pocket3d.core.project.ModelVersion
import dev.pocket3d.core.project.Project
import dev.pocket3d.core.project.ProjectSummary
import dev.pocket3d.core.project.ReconJob
import dev.pocket3d.core.project.TrackingInfo
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import java.io.File
import java.io.OutputStream

/*
 * Service contracts between the feature modules. Implementations live in :data; feature
 * modules (:capture, :viewer) and the :app shell only see these interfaces through [Services].
 * All suspend functions are main-safe (implementations switch to an IO dispatcher).
 */

/** Durable, incremental project storage. Every mutation is written atomically before returning. */
interface ProjectStore {
    /** Library rows, newest first. Updated after every mutation. */
    val summaries: StateFlow<List<ProjectSummary>>

    suspend fun createProject(name: String): Project
    suspend fun project(projectId: String): Project?
    fun observeProject(projectId: String): Flow<Project?>
    suspend fun renameProject(projectId: String, name: String)
    /** Deep copy (photos, models, edits). Jobs are not copied. */
    suspend fun duplicateProject(projectId: String): Project
    /** Local part of the deletion summary; companion fields are filled in by the caller. */
    suspend fun deletionPlan(projectId: String): DeletionPlan
    /** Deletes the project with all photos and models from the phone. */
    suspend fun deleteProject(projectId: String)
    /** Writes a portable .zip of the whole project (photos, metadata, models, edits). */
    suspend fun exportProjectArchive(projectId: String, out: OutputStream, onProgress: (Float) -> Unit = {})
    suspend fun freeBytes(): Long

    // --- capture sessions -------------------------------------------------------------------
    suspend fun createSession(projectId: String, source: CaptureSource, device: DeviceInfo): CaptureSession
    suspend fun session(projectId: String, sessionId: String): CaptureSession?
    fun observeSession(projectId: String, sessionId: String): Flow<CaptureSession?>
    suspend fun sessions(projectId: String): List<CaptureSession>
    /**
     * A fresh temporary file inside the session's frame directory to write photo bytes into.
     * Pass it to [commitFrame]; uncommitted temp files are removed on the next start.
     */
    fun newFrameTempFile(projectId: String, sessionId: String): File
    /**
     * Atomically adds a photo: moves [tempFile] to its final name, fills in `file`, `sizeBytes`
     * and `sha256` of [frame] and appends it to the session (persisted before returning, so a
     * process death after this call never loses the photo). Returns the stored frame.
     */
    suspend fun commitFrame(projectId: String, sessionId: String, frame: Frame, tempFile: File): Frame
    suspend fun updateFrame(projectId: String, sessionId: String, frameId: String, transform: (Frame) -> Frame)
    /** Deletes the photo file and its metadata. */
    suspend fun removeFrame(projectId: String, sessionId: String, frameId: String)
    suspend fun reorderFrames(projectId: String, sessionId: String, orderedIds: List<String>, ordering: String)
    suspend fun updateSessionMeta(projectId: String, sessionId: String, tracking: TrackingInfo?,
                                  objectCenterAr: List<Double>?)
    fun frameFile(projectId: String, sessionId: String, frame: Frame): File
    suspend fun deleteSession(projectId: String, sessionId: String)

    // --- jobs -------------------------------------------------------------------------------
    suspend fun job(projectId: String, jobId: String): ReconJob?
    fun observeJob(projectId: String, jobId: String): Flow<ReconJob?>
    suspend fun jobs(projectId: String): List<ReconJob>
    fun jobDir(projectId: String, jobId: String): File

    // --- models -----------------------------------------------------------------------------
    suspend fun model(projectId: String, modelId: String): ModelVersion?
    suspend fun models(projectId: String): List<ModelVersion>
    /** Directory with model.glb, cameras.json, diagnostics.json (read-only for callers). */
    fun modelDir(projectId: String, modelId: String): File
    suspend fun setActiveModel(projectId: String, modelId: String)
    suspend fun deleteModel(projectId: String, modelId: String)
    suspend fun loadEdits(projectId: String, modelId: String): EditDocument
    suspend fun saveEdits(projectId: String, modelId: String, edits: EditDocument)
    /** PNG rendered from the actual model by the viewer. */
    suspend fun saveThumbnail(projectId: String, modelId: String, png: ByteArray)
}

data class ImportIssue(val sourceName: String, val reason: String)

data class ImportReport(val imported: List<Frame>, val issues: List<ImportIssue>)

/** Copies user-selected photos into a session without recompressing them. */
interface PhotoImporter {
    /**
     * @param uris content:// or file:// URIs from the system picker
     * Each photo is copied byte-for-byte, decoded once to validate it and to measure quality,
     * and its metadata (EXIF orientation, focal length, timestamp) is extracted. Unsupported or
     * corrupt files are reported in [ImportReport.issues], never silently skipped.
     */
    suspend fun importPhotos(projectId: String, sessionId: String, uris: List<String>,
                             onProgress: (done: Int, total: Int) -> Unit = { _, _ -> }): ImportReport
}

/** State of the pairing with a companion computer. */
data class CompanionState(
    val paired: Boolean = false,
    val serverId: String? = null,
    val serverName: String? = null,
    /** Base URL currently in use, e.g. https://192.168.1.20:8443 */
    val baseUrl: String? = null,
    val fingerprintSha256: String? = null,
    /** null = not checked yet. */
    val reachable: Boolean? = null,
    val status: StatusResponse? = null,
    val lastError: String? = null,
    val checking: Boolean = false,
)

sealed interface PairResult {
    data class Success(val serverName: String) : PairResult
    data class Failure(val message: String) : PairResult
}

interface CompanionLink {
    val state: StateFlow<CompanionState>
    /** Tries each advertised host, verifies the pinned certificate fingerprint, exchanges the code. */
    suspend fun pair(info: PairingInfo, deviceName: String): PairResult
    suspend fun unpair()
    /** Re-checks reachability and refreshes [CompanionState.status]. */
    suspend fun refresh()
    /** Asks the companion to delete its copies of the given capture sessions. Returns ids that were removed. */
    suspend fun deleteRemoteSessions(sessionIds: List<String>): List<String>
}

/** Starts and supervises reconstruction jobs. Jobs survive app restarts. */
interface ReconstructionService {
    /**
     * Creates a durable job for the given frames and starts uploading. The previous model of
     * the project stays active until this job has completed and its results are verified.
     */
    suspend fun startJob(projectId: String, sessionId: String, preset: String, frameIds: List<String>): ReconJob
    suspend fun cancelJob(projectId: String, jobId: String)
    suspend fun retryJob(projectId: String, jobId: String)
    suspend fun deleteJob(projectId: String, jobId: String)
    /** Resumes supervision of unfinished jobs (called at app start). */
    fun resumeActiveJobs()
}

/** Manual service locator, populated once by the Application. */
object Services {
    lateinit var store: ProjectStore
    lateinit var importer: PhotoImporter
    lateinit var companion: CompanionLink
    lateinit var reconstruction: ReconstructionService
}

/**
 * What actually happened the last time this process tried to start an ARCore session.
 * "Supported and installed" (what the platform reports before a session exists) is not the same
 * as "works": the capability screen shows this next to it.
 */
object ArRuntimeStatus {
    /** null = no session was attempted yet in this process. */
    @Volatile var lastSessionOk: Boolean? = null
    @Volatile var lastFailure: String? = null

    fun reportStarted() { lastSessionOk = true; lastFailure = null }
    fun reportFailed(reason: String) { lastSessionOk = false; lastFailure = reason.take(200) }
}
