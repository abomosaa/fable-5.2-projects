package dev.pocket3d.capture

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.pocket3d.capture.logic.ReviewLogic
import dev.pocket3d.core.project.CaptureSession
import dev.pocket3d.core.project.Frame
import dev.pocket3d.core.services.ImportIssue
import dev.pocket3d.core.services.PhotoImporter
import dev.pocket3d.core.services.ProjectStore
import dev.pocket3d.core.services.Services
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File

internal data class ReviewImportProgress(val done: Int, val total: Int)

/** Outcome of one "Add photos" run. [error] is set when the import as a whole failed. */
internal data class ReviewImportResult(
    val requested: Int,
    val imported: Int,
    val issues: List<ImportIssue>,
    val error: String? = null,
)

/** One-shot message for the snackbar; [undoExcludeIds] offers "Undo" after a bulk exclude. */
internal data class ReviewMessage(val id: Long, val text: String, val undoExcludeIds: List<String> = emptyList())

internal data class ReviewUiState(
    val loading: Boolean = true,
    /** null after loading = the session does not exist (deleted, or wrong id). */
    val session: CaptureSession? = null,
    val busy: Boolean = false,
    val importProgress: ReviewImportProgress? = null,
    val importResult: ReviewImportResult? = null,
    val message: ReviewMessage? = null,
) {
    val frames: List<Frame> get() = session?.frames.orEmpty()
    val ordering: String get() = session?.ordering ?: ReviewLogic.ORDER_TIME
}

/** [Services.store], or null when the service locator is not populated (previews, tests). */
internal fun reviewStoreOrNull(): ProjectStore? =
    try { Services.store } catch (e: UninitializedPropertyAccessException) { null }

internal fun reviewImporterOrNull(): PhotoImporter? =
    try { Services.importer } catch (e: UninitializedPropertyAccessException) { null }

/**
 * State holder of [FrameReviewScreen]. The stored session is the single source of truth: every
 * action goes through the [ProjectStore] and the UI follows `observeSession`. Failures become a
 * message in the state; nothing is thrown to the UI.
 */
internal class ReviewViewModel(
    private val projectId: String,
    private val sessionId: String,
    private val store: ProjectStore? = reviewStoreOrNull(),
    private val importer: PhotoImporter? = reviewImporterOrNull(),
) : ViewModel() {
    private val _state = MutableStateFlow(ReviewUiState())
    val state: StateFlow<ReviewUiState> = _state.asStateFlow()

    /** Serialises mutations so e.g. a delete and a reorder never interleave. */
    private val mutex = Mutex()
    private var messageSeq = 0L

    init {
        val s = store
        if (s == null) {
            _state.update { it.copy(loading = false) }
            post("Project storage is not available.")
        } else {
            viewModelScope.launch {
                try {
                    s.observeSession(projectId, sessionId).collect { session ->
                        _state.update { it.copy(loading = false, session = session) }
                    }
                } catch (c: CancellationException) {
                    throw c
                } catch (e: Exception) {
                    _state.update { it.copy(loading = false) }
                    post("Could not load the photos: ${reason(e)}")
                }
            }
        }
    }

    /** Photo file of [frame], or null without storage. Cheap (no I/O). */
    fun fileOf(frame: Frame): File? = try {
        store?.frameFile(projectId, sessionId, frame)
    } catch (e: Exception) {
        null
    }

    fun consumeMessage(id: Long) {
        _state.update { if (it.message?.id == id) it.copy(message = null) else it }
    }

    fun dismissImportResult() {
        _state.update { it.copy(importResult = null) }
    }

    /** Excludes/includes photos. The files stay on the phone either way. */
    fun setExcluded(ids: Collection<String>, excluded: Boolean, announce: Boolean = true) {
        val targets = _state.value.frames.filter { it.id in ids && it.excluded != excluded }.map { it.id }
        if (targets.isEmpty()) return
        mutate("Could not update the photos") { s ->
            for (id in targets) s.updateFrame(projectId, sessionId, id) { it.copy(excluded = excluded) }
            if (announce) {
                val n = targets.size
                if (excluded) post("$n ${photos(n)} excluded — files kept on the phone", undoExcludeIds = targets)
                else post("$n ${photos(n)} included again")
            }
        }
    }

    /** Excludes every included photo that has at least one quality flag. */
    fun excludeAllFlagged() {
        val ids = ReviewLogic.flaggedIncludedIds(_state.value.frames)
        if (ids.isEmpty()) {
            post("No included photos have quality flags.")
            return
        }
        setExcluded(ids, true)
    }

    /** Permanently deletes photos (file and metadata). */
    fun delete(ids: Collection<String>) {
        val targets = _state.value.frames.filter { it.id in ids }
        if (targets.isEmpty()) return
        mutate("Could not delete") { s ->
            var deleted = 0
            try {
                for (frame in targets) {
                    val file = try { s.frameFile(projectId, sessionId, frame) } catch (e: Exception) { null }
                    s.removeFrame(projectId, sessionId, frame.id)
                    if (file != null) ThumbnailLoader.evict(file)
                    deleted++
                }
            } finally {
                if (deleted > 0) post("$deleted ${photos(deleted)} deleted from the phone")
            }
        }
    }

    /** Sorts by capture time ("time") or file name ("name") and persists the order. */
    fun setOrdering(ordering: String) {
        if (ReviewLogic.comparator(ordering) == null) return
        mutate("Could not change the order") { s ->
            val current = s.session(projectId, sessionId)?.frames ?: return@mutate
            s.reorderFrames(projectId, sessionId, ReviewLogic.orderedIds(current, ordering), ordering)
        }
    }

    /** Imports picked photos (original bytes) into this session and reports every rejected file. */
    fun importUris(uris: List<String>) {
        if (uris.isEmpty()) return
        val s = store
        val imp = importer
        if (s == null || imp == null) {
            post("Photo import is not available.")
            return
        }
        if (_state.value.importProgress != null) {
            post("An import is already running.")
            return
        }
        _state.update { it.copy(importProgress = ReviewImportProgress(0, uris.size), importResult = null) }
        viewModelScope.launch {
            val result = try {
                mutex.withLock {
                    val report = imp.importPhotos(projectId, sessionId, uris) { done, total ->
                        _state.update { it.copy(importProgress = ReviewImportProgress(done, total)) }
                    }
                    // New photos are appended by the store: put them where the chosen ordering wants them.
                    try {
                        val session = s.session(projectId, sessionId)
                        if (report.imported.isNotEmpty() && session != null) {
                            val wanted = ReviewLogic.orderedIds(session.frames, session.ordering)
                            if (wanted != session.frames.map { it.id }) {
                                s.reorderFrames(projectId, sessionId, wanted, session.ordering)
                            }
                        }
                    } catch (c: CancellationException) {
                        throw c
                    } catch (e: Exception) {
                        // Ordering is cosmetic here; the photos are imported.
                    }
                    ReviewImportResult(uris.size, report.imported.size, report.issues)
                }
            } catch (c: CancellationException) {
                _state.update { it.copy(importProgress = null) }
                throw c
            } catch (e: Exception) {
                ReviewImportResult(uris.size, 0, emptyList(), error = "Import failed: ${reason(e)}")
            }
            _state.update { it.copy(importProgress = null, importResult = result) }
        }
    }

    private fun mutate(failure: String, block: suspend (ProjectStore) -> Unit) {
        val s = store
        if (s == null) {
            post("Project storage is not available.")
            return
        }
        viewModelScope.launch {
            mutex.withLock {
                _state.update { it.copy(busy = true) }
                try {
                    block(s)
                } catch (c: CancellationException) {
                    throw c
                } catch (e: Exception) {
                    post("$failure: ${reason(e)}")
                } finally {
                    _state.update { it.copy(busy = false) }
                }
            }
        }
    }

    /** Shows a one-shot message (used by the screen for picker failures). */
    fun notify(text: String) = post(text)

    private fun post(text: String, undoExcludeIds: List<String> = emptyList()) {
        val message = ReviewMessage(++messageSeq, text, undoExcludeIds)
        _state.update { it.copy(message = message) }
    }

    private fun photos(n: Int) = if (n == 1) "photo" else "photos"

    private fun reason(e: Exception): String = e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName
}
