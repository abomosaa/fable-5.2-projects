package dev.pocket3d.capture

import android.content.ActivityNotFoundException
import android.content.Context
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.pocket3d.core.project.CaptureSource
import dev.pocket3d.core.project.DeviceInfo
import dev.pocket3d.core.services.ImportIssue
import dev.pocket3d.core.services.PhotoImporter
import dev.pocket3d.core.services.ProjectStore
import dev.pocket3d.design.InfoBanner
import dev.pocket3d.design.P3
import dev.pocket3d.design.SectionTitle
import dev.pocket3d.design.StatusPill
import dev.pocket3d.design.Tone
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal data class ImportUiState(
    /** Session the photos go into; null until the first files were picked (created lazily). */
    val sessionId: String? = null,
    val running: Boolean = false,
    val done: Int = 0,
    val total: Int = 0,
    /** Display name of the file being processed, when the picker provides one. */
    val currentName: String? = null,
    /** Totals over all picks made on this screen. */
    val selectedTotal: Int = 0,
    val importedNames: List<String> = emptyList(),
    val issues: List<ImportIssue> = emptyList(),
    val batches: Int = 0,
    /** Photos now in the session (including ones that were there before). */
    val sessionPhotoCount: Int = 0,
    val error: String? = null,
)

/**
 * State holder of [ImportPhotosScreen]: creates the import session on first use, runs the
 * importer and accumulates an explicit result (every imported and every rejected file).
 */
internal class ImportViewModel(
    private val projectId: String,
    initialSessionId: String?,
    private val store: ProjectStore? = reviewStoreOrNull(),
    private val importer: PhotoImporter? = reviewImporterOrNull(),
) : ViewModel() {
    private val _state = MutableStateFlow(ImportUiState(sessionId = initialSessionId))
    val state: StateFlow<ImportUiState> = _state.asStateFlow()

    /** True when this screen created the session (so an empty one can be removed on leaving). */
    private var createdHere = false
    private var job: Job? = null

    init {
        if (initialSessionId != null && store != null) {
            viewModelScope.launch { refreshCount(store, initialSessionId) }
        }
    }

    /**
     * Imports [uris] (original bytes, no recompression). [resolveName] maps a URI to a display
     * name for the progress line; it is called on a background thread and may return null.
     */
    fun importUris(uris: List<String>, resolveName: (String) -> String?) {
        if (uris.isEmpty() || _state.value.running) return
        val s = store
        val imp = importer
        if (s == null || imp == null) {
            _state.update { it.copy(error = "Photo import is not available: storage is not initialised.") }
            return
        }
        _state.update { it.copy(running = true, done = 0, total = uris.size, currentName = null, error = null) }
        job = viewModelScope.launch {
            var sid = _state.value.sessionId
            var before: Set<String>? = null
            var failure: String? = null
            try {
                if (sid == null) {
                    val session = s.createSession(projectId, CaptureSource.IMPORT,
                                                  DeviceInfo(Build.MANUFACTURER.orEmpty(), Build.MODEL.orEmpty(), Build.VERSION.SDK_INT))
                    sid = session.id
                    createdHere = true
                    _state.update { it.copy(sessionId = session.id) }
                    before = emptySet()
                } else {
                    before = s.session(projectId, sid)?.frames?.mapTo(HashSet()) { it.id }
                }
                val names = withContext(Dispatchers.IO) {
                    uris.map { u -> try { resolveName(u) } catch (e: Exception) { null } }
                }
                _state.update { it.copy(currentName = names.firstOrNull()) }
                val report = imp.importPhotos(projectId, sid, uris) { done, total ->
                    _state.update { it.copy(done = done, total = total, currentName = names.getOrNull(done)) }
                }
                _state.update {
                    it.copy(
                        selectedTotal = it.selectedTotal + uris.size,
                        importedNames = it.importedNames + report.imported.map { f -> f.name },
                        issues = it.issues + report.issues,
                        batches = it.batches + 1,
                    )
                }
            } catch (c: CancellationException) {
                failure = "Import cancelled before all files were processed."
            } catch (e: Exception) {
                failure = "Import failed: ${e.message?.takeIf { m -> m.isNotBlank() } ?: e.javaClass.simpleName}."
            } finally {
                withContext(NonCancellable) {
                    val id = sid
                    val message = failure
                    if (message != null) {
                        // The importer's report is lost: read back from the store what actually arrived.
                        val known = before
                        val arrived = if (id == null || known == null) null else try {
                            s.session(projectId, id)?.frames?.filter { it.id !in known }?.map { it.name }
                        } catch (e: Exception) {
                            null
                        }
                        _state.update {
                            it.copy(
                                selectedTotal = it.selectedTotal + uris.size,
                                importedNames = it.importedNames + arrived.orEmpty(),
                                batches = it.batches + 1,
                                error = message + when {
                                    arrived == null -> " Photos that were already copied are kept."
                                    arrived.isEmpty() -> " No photos from this selection were copied."
                                    else -> " ${arrived.size} of ${uris.size} files were copied before that and are kept; " +
                                        "the rest were not processed."
                                },
                            )
                        }
                    }
                    if (id != null) refreshCount(s, id)
                    _state.update { it.copy(running = false, currentName = null) }
                }
            }
        }
    }

    fun cancel() {
        job?.cancel()
    }

    fun dismissError() {
        _state.update { it.copy(error = null) }
    }

    /**
     * Removes the session if this screen created it and nothing was imported, so leaving the
     * screen does not leave an empty capture session behind. Never throws.
     */
    suspend fun discardEmptySession() {
        val s = store ?: return
        val sid = _state.value.sessionId ?: return
        if (!createdHere || _state.value.running) return
        try {
            val session = s.session(projectId, sid)
            if (session != null && session.frames.isEmpty()) {
                s.deleteSession(projectId, sid)
                createdHere = false
                _state.update { it.copy(sessionId = null, sessionPhotoCount = 0) }
            }
        } catch (c: CancellationException) {
            throw c
        } catch (e: Exception) {
            // An empty leftover session is harmless.
        }
    }

    private suspend fun refreshCount(s: ProjectStore, sid: String) {
        try {
            val count = s.session(projectId, sid)?.frames?.size ?: 0
            _state.update { it.copy(sessionPhotoCount = count) }
        } catch (c: CancellationException) {
            throw c
        } catch (e: Exception) {
            // Keep the previous count; the review screen shows the stored truth.
        }
    }
}

/**
 * Import of existing photos into a capture session. Files are copied byte-for-byte; every
 * rejected file is listed with its reason.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ImportPhotosScreen(
    projectId: String,
    sessionId: String?,
    onImported: (sessionId: String) -> Unit,
    onBack: () -> Unit,
) {
    // Survives process death: the session created here must not be created a second time.
    var createdSessionId by rememberSaveable { mutableStateOf<String?>(null) }
    val vm: ImportViewModel = viewModel(
        key = "import/$projectId/${sessionId ?: "new"}",
        factory = viewModelFactory { initializer { ImportViewModel(projectId, sessionId ?: createdSessionId) } },
    )
    val state by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(state.sessionId) {
        if (sessionId == null) createdSessionId = state.sessionId
    }

    val appContext = LocalContext.current.applicationContext
    val scope = rememberCoroutineScope()
    var pickerError by rememberSaveable { mutableStateOf<String?>(null) }
    val onPicked: (List<Uri>) -> Unit = { uris ->
        if (uris.isNotEmpty()) vm.importUris(uris.map { it.toString() }) { importDisplayName(appContext, it) }
    }
    val documents = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments(), onPicked)
    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(), onPicked)
    val chooseFiles: () -> Unit = {
        pickerError = null
        try {
            documents.launch(arrayOf("image/*"))
        } catch (e: ActivityNotFoundException) {
            pickerError = "No file picker is available on this device. Try the photo picker instead."
        }
    }
    val choosePhotos: () -> Unit = {
        pickerError = null
        try {
            photoPicker.launch(
                PickVisualMediaRequest.Builder().setMediaType(ActivityResultContracts.PickVisualMedia.ImageOnly).build()
            )
        } catch (e: ActivityNotFoundException) {
            pickerError = "The photo picker is not available on this device. Use \"Choose files\" instead."
        }
    }
    val leave: () -> Unit = {
        if (state.running) vm.cancel()
        else scope.launch { vm.discardEmptySession(); onBack() }
    }
    BackHandler(onBack = leave)

    val reviewSessionId = state.sessionId
    val canReview = reviewSessionId != null && state.sessionPhotoCount > 0 && !state.running
    val hasResult = state.batches > 0

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Import photos") },
                navigationIcon = {
                    IconButton(onClick = leave) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, if (state.running) "Cancel import" else "Back")
                    }
                },
            )
        },
        bottomBar = {
            Surface(tonalElevation = 3.dp) {
                Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp, vertical = 10.dp)) {
                    if (!canReview && !state.running) {
                        Text(
                            if (hasResult) "No photos were imported, so there is nothing to review yet."
                            else "Choose photos first.",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(bottom = 8.dp),
                        )
                    }
                    Button(
                        onClick = { if (reviewSessionId != null) onImported(reviewSessionId) },
                        enabled = canReview,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).semantics {
                            if (!canReview) stateDescription = if (state.running) "Unavailable while importing" else "Unavailable: no photos imported"
                        },
                    ) {
                        Text(if (state.sessionPhotoCount > 0) "Review photos (${state.sessionPhotoCount})" else "Review photos")
                    }
                }
            }
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 20.dp),
        ) {
            item(key = "intro") {
                Text(
                    "Use photos you already took of one stationary object: 20 or more overlapping views from all " +
                        "around it, in stable light. Photos from several cameras or zoom levels can be mixed, but " +
                        "screenshots, edited or heavily cropped pictures usually fail.",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(12.dp))
                InfoBanner(
                    title = "Originals are copied as they are",
                    body = "No recompression, resizing or rotation. The app keeps its own copy inside the project; " +
                        "your gallery is not changed. Reconstruction runs later on the companion computer.",
                    tone = Tone.Neutral,
                )
                Spacer(Modifier.height(16.dp))
                Button(onClick = chooseFiles, enabled = !state.running, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
                    Icon(Icons.Outlined.FolderOpen, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(if (hasResult) "Add more files" else "Choose files")
                }
                Text(
                    "Recommended. The system file browser hands over the unmodified files (JPEG, PNG, WebP, HEIC).",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp, bottom = 12.dp),
                )
                OutlinedButton(onClick = choosePhotos, enabled = !state.running, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
                    Icon(Icons.Outlined.PhotoLibrary, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(if (hasResult) "Add more with photo picker" else "Photo picker")
                }
                Text(
                    "Alternative with a gallery view. Android's photo picker may remove location data from the copy " +
                        "it hands over; orientation and focal length, which reconstruction uses, are normally kept.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp),
                )
                val pickerMessage = pickerError
                if (pickerMessage != null) {
                    Spacer(Modifier.height(12.dp))
                    InfoBanner(title = "Picker not available", body = pickerMessage, tone = Tone.Bad)
                }
            }

            if (state.running) {
                item(key = "progress") {
                    Spacer(Modifier.height(20.dp))
                    ImportProgressCard(state, onCancel = { vm.cancel() })
                }
            }

            val error = state.error
            if (error != null && !state.running) {
                item(key = "error") {
                    Spacer(Modifier.height(16.dp))
                    InfoBanner(title = "Import did not finish", body = error, tone = Tone.Bad,
                               actionLabel = "Dismiss", onAction = { vm.dismissError() })
                }
            }

            if (hasResult && !state.running) {
                item(key = "result-header") {
                    SectionTitle("Result")
                    val imported = state.importedNames.size
                    Text(
                        "$imported of ${state.selectedTotal} selected ${if (state.selectedTotal == 1) "file" else "files"} imported",
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.semantics { heading(); liveRegion = LiveRegionMode.Polite },
                    )
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        StatusPill("Imported · $imported", if (imported > 0) Tone.Good else Tone.Neutral, icon = Icons.Outlined.Check)
                        StatusPill("Rejected · ${state.issues.size}", if (state.issues.isNotEmpty()) Tone.Bad else Tone.Neutral,
                                   icon = Icons.Outlined.ErrorOutline)
                    }
                    if (state.issues.isEmpty() && imported > 0) {
                        Text("Every selected file was imported.", style = MaterialTheme.typography.bodySmall,
                             color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
                    }
                }
                if (state.issues.isNotEmpty()) {
                    item(key = "rejected-title") {
                        Text("Rejected files", style = MaterialTheme.typography.titleSmall,
                             modifier = Modifier.padding(top = 16.dp, bottom = 2.dp).semantics { heading() })
                    }
                    itemsIndexed(state.issues, key = { i, _ -> "issue-$i" }) { _, issue ->
                        ImportFileRow(name = issue.sourceName.ifBlank { "Unnamed file" }, detail = issue.reason, rejected = true)
                    }
                }
                if (state.importedNames.isNotEmpty()) {
                    item(key = "imported-title") {
                        Text("Imported files", style = MaterialTheme.typography.titleSmall,
                             modifier = Modifier.padding(top = 16.dp, bottom = 2.dp).semantics { heading() })
                    }
                    itemsIndexed(state.importedNames, key = { i, _ -> "ok-$i" }) { _, name ->
                        ImportFileRow(name = name, detail = null, rejected = false)
                    }
                }
            }
        }
    }
}

@Composable
private fun ImportProgressCard(state: ImportUiState, onCancel: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surfaceContainer, shape = MaterialTheme.shapes.medium,
            modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Text("Importing", style = MaterialTheme.typography.titleSmall, modifier = Modifier.semantics { heading() })
            Spacer(Modifier.height(10.dp))
            val fraction = if (state.total > 0) (state.done.toFloat() / state.total).coerceIn(0f, 1f) else 0f
            LinearProgressIndicator(
                progress = { fraction },
                modifier = Modifier.fillMaxWidth().semantics {
                    contentDescription = "${state.done} of ${state.total} files processed"
                },
            )
            Spacer(Modifier.height(10.dp))
            Text("${state.done} of ${state.total} files processed", style = MaterialTheme.typography.bodyMedium)
            val current = state.currentName
            if (current != null && state.done < state.total) {
                Text("Copying and checking $current", style = MaterialTheme.typography.bodySmall,
                     color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            TextButton(onClick = onCancel, modifier = Modifier.align(Alignment.End).heightIn(min = 48.dp)) {
                Text("Cancel import")
            }
        }
    }
}

@Composable
private fun ImportFileRow(name: String, detail: String?, rejected: Boolean) {
    Column(
        Modifier.fillMaxWidth().semantics(mergeDescendants = true) {
            stateDescription = if (rejected) "Rejected" else "Imported"
        },
    ) {
        Row(Modifier.padding(vertical = 8.dp), verticalAlignment = Alignment.Top) {
            if (rejected) Icon(Icons.Outlined.ErrorOutline, null, Modifier.size(18.dp), tint = P3.colors.bad)
            else Icon(Icons.Outlined.Check, null, Modifier.size(18.dp), tint = P3.colors.good)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(name, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (detail != null) {
                    Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        HorizontalDivider()
    }
}

/** Display name of a picked document, or null when the provider does not report one. */
private fun importDisplayName(context: Context, uri: String): String? = try {
    context.contentResolver.query(Uri.parse(uri), arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst() && !c.isNull(0)) c.getString(0) else null
    }
} catch (e: Exception) {
    null
}
