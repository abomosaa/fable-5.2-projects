package dev.pocket3d.viewer

import android.content.Context
import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.pocket3d.core.edit.EditDocument
import dev.pocket3d.core.edit.EditEngine
import dev.pocket3d.core.edit.EditOp
import dev.pocket3d.core.edit.Measurement
import dev.pocket3d.core.math.Mat4
import dev.pocket3d.core.math.Quat
import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.mesh.Aabb
import dev.pocket3d.core.mesh.Bvh
import dev.pocket3d.core.mesh.Hole
import dev.pocket3d.core.mesh.Mesh
import dev.pocket3d.core.mesh.MeshOps
import dev.pocket3d.core.mesh.MeshSelection
import dev.pocket3d.core.mesh.MeshTopology
import dev.pocket3d.core.mesh.OrientedBox
import dev.pocket3d.core.project.CaptureSession
import dev.pocket3d.core.scale.ScaleCalibration
import dev.pocket3d.core.services.Services
import dev.pocket3d.viewer.camera.OrbitCamera
import dev.pocket3d.viewer.camera.StandardView
import dev.pocket3d.viewer.camera.ViewportController
import dev.pocket3d.viewer.data.LoadedModel
import dev.pocket3d.viewer.data.MeshHistory
import dev.pocket3d.viewer.data.ModelLoadException
import dev.pocket3d.viewer.data.ModelLoader
import dev.pocket3d.viewer.export.ExportBuilder
import dev.pocket3d.viewer.export.ExportCheck
import dev.pocket3d.viewer.export.ExportFormat
import dev.pocket3d.viewer.export.ExportIo
import dev.pocket3d.viewer.export.ExportIoException
import dev.pocket3d.viewer.export.ExportVerifier
import dev.pocket3d.viewer.gl.BackgroundStyle
import dev.pocket3d.viewer.gl.CropPreview
import dev.pocket3d.viewer.gl.Loupe
import dev.pocket3d.viewer.gl.SceneBridge
import dev.pocket3d.viewer.gl.ShadingMode
import dev.pocket3d.viewer.gl.Thumbnail
import dev.pocket3d.viewer.measure.LengthInput
import dev.pocket3d.viewer.measure.LengthUnit
import dev.pocket3d.viewer.measure.Measuring
import dev.pocket3d.viewer.measure.ScaleStatus
import dev.pocket3d.viewer.measure.formatPercentUncertainty
import dev.pocket3d.viewer.scene.CameraPicker
import dev.pocket3d.viewer.scene.CropGizmo
import dev.pocket3d.viewer.scene.EvidenceStats
import dev.pocket3d.viewer.scene.HoleList
import dev.pocket3d.viewer.scene.LineBuilder
import dev.pocket3d.viewer.scene.MeshBuffers
import dev.pocket3d.viewer.scene.SceneBuilders
import dev.pocket3d.viewer.scene.ViewpointCoverage
import dev.pocket3d.viewer.scene.WireEdges
import dev.pocket3d.viewer.ui.ViewportInput
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.util.UUID
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * State and logic of the model viewer. All mesh work runs off the main thread; the GL thread
 * only ever receives immutable snapshots through [bridge]. The reconstruction's GLB is never
 * modified: every change goes through the [EditDocument], which is saved after each committed
 * operation.
 */
class ViewerViewModel(
    private val projectId: String,
    private val modelId: String,
    private val appContext: Context,
    /** Display density, for line widths and touch targets. */
    private val density: Float,
    lowRam: Boolean,
) : ViewModel(), ViewportInput {

    val bridge = SceneBridge(viewModelScope, maxTextureSide = if (lowRam) 2048 else 4096,
                             texturePixelBudget = if (lowRam) 12_000_000L else 50_000_000L)
    val controller = ViewportController(viewModelScope) { bridge.setCamera(it) }

    private val _state = MutableStateFlow(ViewerUiState())
    val state: StateFlow<ViewerUiState> = _state.asStateFlow()

    // Heavy work runs here so that cancelling in the UI returns immediately (the computation itself
    // cannot be interrupted; its result is then simply dropped).
    @OptIn(ExperimentalCoroutinesApi::class)
    private val heavy = CoroutineScope(SupervisorJob() + Dispatchers.Default.limitedParallelism(2))
    @OptIn(ExperimentalCoroutinesApi::class)
    private val previewScope = CoroutineScope(SupervisorJob() + Dispatchers.Default.limitedParallelism(1))
    private suspend fun <T> compute(block: () -> T): T = heavy.async { block() }.await()

    private var loaded: LoadedModel? = null
    private var history: MeshHistory? = null
    private var session: CaptureSession? = null

    /** The current edited mesh. */
    private var mesh: Mesh? = null
    /** What is in the viewport: [mesh], or the simplification preview. */
    private var displayed: Mesh? = null
    private var previewMesh: Mesh? = null
    private var bvh: Bvh? = null
    private var topology: MeshTopology? = null
    private var holes: List<Hole> = emptyList()
    private var selection: BooleanArray? = null
    private var meshVersion = 0
    private var wireVersion = -1

    private var loadJob: Job? = null
    private var opJob: Job? = null
    private var analysisJob: Job? = null
    private var wireJob: Job? = null
    private var thumbnailJob: Job? = null
    private var previewJob: Job? = null
    private var previewToken = 0
    private var exportJob: Job? = null
    private val saveMutex = Mutex()
    private var noticeId = 0L
    private var lookTarget: OrbitCamera? = null
    private var drag: Drag? = null

    private sealed interface Drag {
        class CropFace(val face: Int, val start: OrientedBox, val grab: Float) : Drag
        class CropMove(val start: OrientedBox, val delta: Vec3) : Drag
        data object Lasso : Drag
        class MeasureEnd(val id: String, val endA: Boolean, val original: Measurement) : Drag
        data object Pending : Drag
        class CalibEnd(val isA: Boolean) : Drag
        data object NewPoint : Drag
    }

    private val dp: Float get() = density
    private val s: ViewerUiState get() = _state.value

    init {
        viewModelScope.launch { bridge.error.collect { e -> _state.update { it.copy(glError = e) } } }
        viewModelScope.launch { bridge.textureReport.collect { r -> _state.update { it.copy(textures = r) } } }
        load()
    }

    override fun onCleared() {
        heavy.cancel()
        previewScope.cancel()
    }

    // ---- loading -------------------------------------------------------------------------------

    fun load() {
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            _state.update { ViewerUiState(background = it.background) }
            try {
                val lm = ModelLoader.load(projectId, modelId) { stage -> _state.update { it.copy(load = LoadState.Loading(stage)) } }
                onLoaded(lm)
            } catch (e: ModelLoadException) {
                _state.update { it.copy(load = LoadState.Failed(e.title, e.detail)) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: OutOfMemoryError) {
                _state.update { it.copy(load = LoadState.Failed("Not enough memory", "The model is too large to open on this device.")) }
            } catch (e: Exception) {
                _state.update { it.copy(load = LoadState.Failed("The model could not be opened", e.message ?: e.javaClass.simpleName)) }
            }
        }
    }

    private suspend fun onLoaded(lm: LoadedModel) {
        loaded = lm
        history = MeshHistory(lm.glb.mesh).also { it.remember(lm.doc.ops, lm.current) }
        val hasTex = lm.current.materials.any { it.baseColorTexture != null } && lm.current.uvs != null
        val hasConf = lm.current.confidence != null
        session = try { Services.store.session(projectId, lm.model.sessionId) } catch (e: Exception) {
            if (e is CancellationException) throw e
            null
        }
        val effective = EditEngine.effectiveScale(lm.doc, lm.reconstructionScale)
        _state.update {
            it.copy(
                title = lm.model.name.ifBlank { "Model" }, model = lm.model, doc = lm.doc, effectiveScale = effective,
                scaleStatus = ScaleStatus.of(lm.doc, lm.reconstructionScale), extras = lm.extras, diagnostics = lm.diagnostics,
                loadNotes = lm.notes, hasConfidence = hasConf, hasTextures = hasTex,
                shading = if (hasTex) ShadingMode.Textured else ShadingMode.Solid,
            )
        }
        bridge.updateSettings { it.copy(shading = s.shading, background = s.background) }
        refreshCameras()
        showMesh(lm.current, reset = true)
        _state.update { it.copy(load = LoadState.Ready) }
        if (lm.notes.isNotEmpty()) notice(lm.notes.first())
        scheduleThumbnail(400)
    }

    // ---- showing a mesh ------------------------------------------------------------------------

    private suspend fun showMesh(m: Mesh, reset: Boolean = false, pivotFix: ((Vec3) -> Vec3)? = null) {
        val version = ++meshVersion
        mesh = m; displayed = m; previewMesh = null
        bvh = null; topology = null; holes = emptyList(); selection = null
        analysisJob?.cancel(); wireJob?.cancel(); previewJob?.cancel()
        val buffers = compute { MeshBuffers.build(m) }
        if (version != meshVersion) return
        bridge.setMesh(buffers)
        val camRadius = s.cameras.placed.maxOfOrNull { it.position.distanceTo(buffers.bounds.center) }?.times(1.15f) ?: 0f
        controller.setScene(buffers.bounds, extraRadius = if (s.showCameras) camRadius else 0f, reset = reset, pivotFix = pivotFix)
        _state.update {
            it.copy(meshVersion = version, faceCount = m.faceCount, vertexCount = m.vertexCount, bounds = buffers.bounds,
                    pickingReady = false, analysis = null, select = it.select.copy(selectedFaces = 0, lassoPath = emptyList()),
                    holes = HolesUi(), simplify = SimplifyUi(fraction = it.simplify.fraction), orient = OrientUi(),
                    hasConfidence = m.confidence != null)
        }
        resetToolGeometry()
        syncGrid()
        syncHoleLines()
        syncCameraLines()
        syncGizmo()
        refreshMeasurementRows()
        if (s.shading == ShadingMode.Wireframe) ensureWire()
        startAnalysis(version, m)
    }

    private fun startAnalysis(version: Int, m: Mesh) {
        analysisJob = viewModelScope.launch {
            try {
                val b = compute { Bvh.build(m) }
                if (version != meshVersion) return@launch
                bvh = b
                _state.update { it.copy(pickingReady = true) }
                refreshMeasurementRows()
                val a = compute {
                    val stats = MeshOps.stats(m, EvidenceStats.WELL)
                    val hs = MeshOps.findHoles(m)
                    val comps = MeshOps.components(m)
                    Triple(stats, hs, comps) to EvidenceStats.of(m)
                }
                if (version != meshVersion) return@launch
                val (stats, hs, comps) = a.first
                holes = hs
                val entries = HoleList.build(hs, stats.bounds.diagonal)
                _state.update {
                    it.copy(analysis = MeshAnalysis(stats, a.second, entries, hs.sumOf { h -> h.perimeter.toDouble() }.toFloat(),
                                                    comps.components.map { c -> c.area }))
                }
                syncHoleLines()
            } catch (e: CancellationException) {
                throw e
            } catch (e: OutOfMemoryError) {
                notice("Not enough memory to analyse the model; statistics are unavailable.")
            } catch (e: Exception) {
                notice("The model could not be analysed: ${e.message ?: e.javaClass.simpleName}")
            }
        }
    }

    private fun ensureWire() {
        val m = displayed ?: return
        val version = meshVersion
        val token = System.identityHashCode(m)
        if (wireVersion == token) return
        wireJob?.cancel()
        wireJob = viewModelScope.launch {
            val buf = compute { WireEdges.build(m.indices).let { e -> WireEdges.toBuffer(e) to e.size } }
            if (version != meshVersion || displayed !== m) return@launch
            wireVersion = token
            bridge.setWire(buf.first, buf.second)
        }
    }

    // ---- view settings -------------------------------------------------------------------------

    fun setTool(t: ToolMode) {
        if (s.tool == t) return
        leaveTransientStates()
        _state.update { it.copy(tool = t) }
        if (t == ToolMode.Cameras && !s.showCameras && s.cameras.available) setShowCameras(true)
        onToolChanged()
    }

    fun setEditTool(t: EditTool) {
        if (s.editTool == t) return
        leaveTransientStates()
        _state.update { it.copy(editTool = t) }
        onToolChanged()
    }

    private fun leaveTransientStates() {
        drag = null
        setLoupe(null)
        if (previewMesh != null) restoreDisplayedMesh()
        _state.update {
            it.copy(select = it.select.copy(lassoPath = emptyList()), orient = it.orient.copy(pickUp = false),
                    holes = it.holes.copy(confirming = false),
                    measure = it.measure.copy(pending = null, candidate = null, calibration = null, renamingId = null))
        }
    }

    private fun onToolChanged() {
        resetToolGeometry()
        syncGizmo()
        syncHoleLines()
        if (s.tool == ToolMode.Edit && s.editTool == EditTool.Simplify && s.simplify.preview == null) requestSimplifyPreview()
    }

    /** (Re)creates the crop box / trim plane for the current mesh. */
    private fun resetToolGeometry() {
        _state.update { it.copy(crop = initialCrop(), trim = initialTrim()) }
    }

    fun setShading(mode: ShadingMode) {
        if (mode == ShadingMode.Evidence && !s.hasConfidence) { notice("This model carries no evidence values."); return }
        _state.update { it.copy(shading = mode) }
        bridge.updateSettings { it.copy(shading = mode) }
        if (mode == ShadingMode.Wireframe) ensureWire()
    }

    fun setBackground(b: BackgroundStyle) {
        _state.update { it.copy(background = b) }
        bridge.updateSettings { it.copy(background = b) }
    }

    fun setShowGrid(on: Boolean) {
        _state.update { it.copy(showGrid = on) }
        bridge.updateSettings { it.copy(showGrid = on) }
        syncGrid()
    }

    fun setShowAxes(on: Boolean) = _state.update { it.copy(showAxes = on) }

    fun setShowHoles(on: Boolean) {
        _state.update { it.copy(showHoles = on) }
        syncHoleLines()
    }

    fun setShowCameras(on: Boolean) {
        _state.update { it.copy(showCameras = on) }
        syncCameraLines()
        val b = s.bounds ?: return
        val camRadius = s.cameras.placed.maxOfOrNull { it.position.distanceTo(b.center) }?.times(1.15f) ?: 0f
        controller.setScene(b, extraRadius = if (on) camRadius else 0f)
    }

    fun fitToView() { lookTarget = null; controller.fit() }
    fun standardView(v: StandardView) { lookTarget = null; controller.standardView(v) }

    fun dismissNotice() = _state.update { it.copy(notice = null) }

    private fun notice(text: String) = _state.update { it.copy(notice = Notice(text, ++noticeId)) }

    private fun setLoupe(l: Loupe?) {
        if (s.loupe == l) return
        _state.update { it.copy(loupe = l) }
        bridge.updateSettings { it.copy(loupe = l) }
    }

    private fun loupeAt(x: Float, y: Float): Loupe {
        val size = (128 * dp).roundToInt()
        val margin = (8 * dp).roundToInt()
        val w = controller.width; val h = controller.height
        val left = (x - size / 2f).roundToInt().coerceIn(margin, max(margin, w - size - margin))
        var top = (y - size - 64 * dp).roundToInt()
        if (top < margin) top = (y + 64 * dp).roundToInt()
        top = top.coerceIn(0, max(0, h - size))
        return Loupe(x, y, size / 3f, left, top, size)
    }

    // ---- overlays ------------------------------------------------------------------------------

    private fun syncGrid() {
        val b = s.bounds
        if (!s.showGrid || b == null) { bridge.setGrid(null); _state.update { it.copy(gridStepText = null) }; return }
        val extent = max(max(b.size.x, b.size.z), b.size.y * 0.5f) * 1.6f
        val scale = s.effectiveScale
        // choose a round step in the units the user reads (metres when calibrated)
        val step = if (scale != null) (SceneBuilders.niceStep((extent * scale.metersPerUnit).toFloat()) / scale.metersPerUnit).toFloat()
        else SceneBuilders.niceStep(extent)
        bridge.setGrid(SceneBuilders.grid(Vec3(b.center.x, b.min.y, b.center.z), Vec3.Y, extent / 2f, step))
        _state.update { it.copy(gridStepText = Measuring.formatModelLength(step.toDouble(), scale)) }
    }

    private fun syncHoleLines() {
        val inRepair = s.tool == ToolMode.Edit && s.editTool == EditTool.Holes
        if ((!s.showHoles && !inRepair) || holes.isEmpty() || previewMesh != null) { bridge.setLines(LINES_HOLES, null); return }
        val chosen = chosenHoleIndices()
        val b = LineBuilder(holes.sumOf { it.edgeCount })
        SceneBuilders.addHoleLoops(b, holes) { h -> if (inRepair && h.index in chosen) COLOR_HOLE_CHOSEN else COLOR_HOLE }
        bridge.setLines(LINES_HOLES, b.build(3f * dp, depthTest = true))
    }

    private fun syncCameraLines() {
        val c = s.cameras
        if (!s.showCameras || c.placed.isEmpty()) { bridge.setLines(LINES_CAMERAS, null); return }
        val b = SceneBuilders.frusta(c.placed, c.frustumSize, COLOR_CAMERA, c.selectedId, COLOR_CAMERA_SELECTED)
        bridge.setLines(LINES_CAMERAS, b.build(1.6f * dp, depthTest = true))
    }

    private fun syncGizmo() {
        val st = s
        val bounds = st.bounds
        if (st.tool == ToolMode.Edit && st.editTool == EditTool.Crop && st.crop != null) {
            val box = st.crop.box
            val ax = box.axis(0); val ay = box.axis(1); val az = box.axis(2)
            bridge.updateSettings {
                it.copy(crop = CropPreview.box(box.center.toArray(), floatArrayOf(ax.x, ax.y, ax.z, ay.x, ay.y, ay.z, az.x, az.y, az.z),
                                               box.halfExtents.toArray()))
            }
            bridge.setLines(LINES_GIZMO, LineBuilder().addSegments(CropGizmo.edgeSegments(box), COLOR_GIZMO).build(2f * dp, depthTest = false))
        } else if (st.tool == ToolMode.Edit && st.editTool == EditTool.Trim && st.trim != null && bounds != null) {
            val t = st.trim
            val p = t.point
            bridge.updateSettings { it.copy(crop = CropPreview.plane(t.normal.x, t.normal.y, t.normal.z, -t.normal.dot(p))) }
            // centre the outline under the model
            val c = bounds.center - t.normal * (t.normal.dot(bounds.center - p))
            val lb = LineBuilder()
            SceneBuilders.addPlaneQuad(lb, c, t.normal, bounds.diagonal * 0.55f, COLOR_PLANE)
            bridge.setLines(LINES_GIZMO, lb.build(2f * dp, depthTest = true))
        } else {
            bridge.updateSettings { it.copy(crop = null) }
            bridge.setLines(LINES_GIZMO, null)
        }
    }

    private fun syncSelection() {
        val m = mesh; val sel = selection
        if (m == null || sel == null) {
            bridge.setSelection(null, 0)
            _state.update { it.copy(select = it.select.copy(selectedFaces = 0)) }
            return
        }
        val n = MeshSelection.count(sel)
        bridge.setSelection(if (n == 0) null else MeshBuffers.selectionIndices(m, sel), n * 3)
        _state.update { it.copy(select = it.select.copy(selectedFaces = n)) }
    }

    // ---- edit stack ----------------------------------------------------------------------------

    private fun setBusy(label: String?) = _state.update { it.copy(busy = label?.let { l -> Busy(l) }) }

    /** Makes [doc] the current document and persists it. */
    private fun commitDoc(doc: EditDocument, cameraFrameChanged: Boolean = false) {
        val recon = loaded?.reconstructionScale
        _state.update {
            it.copy(doc = doc, effectiveScale = EditEngine.effectiveScale(doc, recon), scaleStatus = ScaleStatus.of(doc, recon))
        }
        if (cameraFrameChanged) refreshCameras()
        save(doc)
    }

    private fun save(doc: EditDocument) {
        // Not tied to the screen: a save that was started is finished even if the user leaves.
        viewModelScope.launch(NonCancellable + Dispatchers.Main.immediate) {
            saveMutex.withLock {
                try {
                    Services.store.saveEdits(projectId, modelId, doc)
                } catch (e: Exception) {
                    notice("Edits could not be saved: ${e.message ?: e.javaClass.simpleName}")
                }
            }
        }
        scheduleThumbnail(1500)
    }

    /**
     * Applies one operation to the current mesh and, if it changed something, pushes it onto the
     * edit stack. Operations the engine refuses (they would remove everything) are reported with
     * the engine's own note and nothing changes.
     */
    private fun commit(op: EditOp, precomputed: Mesh? = null, pivotFix: ((Vec3) -> Vec3)? = null) {
        val m = mesh ?: return
        val doc = s.doc ?: return
        if (s.busy != null) return
        opJob = viewModelScope.launch {
            setBusy(op.label)
            try {
                val result = if (precomputed != null) EditEngine.Result(precomputed, emptyList())
                else compute { EditEngine.apply(m, EditDocument(doc.baseSha256, listOf(op))) }
                if (result.notes.isNotEmpty()) { notice(result.notes.first()); return@launch }
                val unchanged = result.mesh === m ||
                    (result.mesh.faceCount == m.faceCount && result.mesh.vertexCount == m.vertexCount &&
                        result.mesh.indices.contentEquals(m.indices) && result.mesh.positions.contentEquals(m.positions))
                if (unchanged) {
                    notice(if (op is EditOp.FillHoles) "No hole could be closed safely; nothing was changed."
                           else "\"${op.label}\" would not change the model; nothing was done.")
                    return@launch
                }
                val newDoc = doc.push(op)
                history?.remember(newDoc.ops, result.mesh)
                commitDoc(newDoc, cameraFrameChanged = op is EditOp.Reorient)
                showMesh(result.mesh, pivotFix = pivotFix)
                if (op is EditOp.FillHoles) {
                    val added = result.mesh.faceCount - m.faceCount
                    notice("Added $added synthetic faces. They are marked as repaired in the viewer and in exports.")
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: OutOfMemoryError) {
                notice("Not enough memory for \"${op.label}\".")
            } catch (e: Exception) {
                notice("\"${op.label}\" failed: ${e.message ?: e.javaClass.simpleName}")
            } finally {
                setBusy(null)
            }
        }
    }

    /** Switches to another state of the edit stack (undo, redo, reset). */
    private fun switchTo(newDoc: EditDocument, label: String, pivotFix: ((Vec3) -> Vec3)? = null) {
        val h = history ?: return
        if (s.busy != null) return
        opJob = viewModelScope.launch {
            setBusy(label)
            try {
                val result = compute { synchronized(h) { h.meshFor(newDoc) } }
                commitDoc(newDoc, cameraFrameChanged = true)
                showMesh(result.mesh, pivotFix = pivotFix)
                result.notes.firstOrNull()?.let { notice(it) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: OutOfMemoryError) {
                notice("Not enough memory for this step.")
            } catch (e: Exception) {
                notice("$label failed: ${e.message ?: e.javaClass.simpleName}")
            } finally {
                setBusy(null)
            }
        }
    }

    fun undo() {
        val doc = s.doc ?: return
        val op = doc.ops.lastOrNull() ?: return
        val fix: ((Vec3) -> Vec3)? = (op as? EditOp.Reorient)?.let { r ->
            Mat4.invert(r.matrix())?.let { inv -> { p: Vec3 -> Mat4.transformPoint(inv, p) } }
        }
        switchTo(doc.undo(), "Undo: ${op.label}", fix)
    }

    fun redo() {
        val doc = s.doc ?: return
        val op = doc.redo.lastOrNull() ?: return
        val fix: ((Vec3) -> Vec3)? = (op as? EditOp.Reorient)?.let { r -> { p: Vec3 -> Mat4.transformPoint(r.matrix(), p) } }
        switchTo(doc.redo(), "Redo: ${op.label}", fix)
    }

    fun requestReset() = _state.update { it.copy(confirmReset = true) }
    fun cancelReset() = _state.update { it.copy(confirmReset = false) }

    fun confirmReset() {
        _state.update { it.copy(confirmReset = false) }
        val doc = s.doc ?: return
        if (doc.ops.isEmpty() && doc.redo.isEmpty()) return
        switchTo(doc.reset(), "Reset all edits")
    }

    /** Stops waiting for the running operation. Its result is discarded. */
    fun cancelBusy() {
        opJob?.cancel()
        exportJob?.cancel()
        _state.update { it.copy(busy = null, export = it.export.copy(stage = null)) }
    }

    // ---- crop ----------------------------------------------------------------------------------

    private fun initialCrop(): CropUi? {
        val b = s.bounds ?: return null
        val doc = s.doc
        val suggestion = loaded?.extras?.suggestedCrop
        val alreadyCropped = doc?.ops?.any { it is EditOp.Crop } == true
        if (suggestion != null && doc != null && !alreadyCropped) {
            val m = doc.currentFromBase()
            val r = SceneBuilders.currentRotation(doc)
            val box = OrientedBox(Mat4.transformPoint(m, suggestion.box.center), (r * suggestion.box.rotation).normalized(),
                                  suggestion.box.halfExtents)
            return CropUi(box, true, suggestion.basis, suggestion.uncertain)
        }
        return CropUi(CropGizmo.fromBounds(b), false, "", false)
    }

    private fun setCropBox(box: OrientedBox, yawDeg: Float? = null) {
        _state.update { st -> st.copy(crop = st.crop?.let { c -> c.copy(box = box, yawDeg = yawDeg ?: c.yawDeg) }) }
        syncGizmo()
    }

    fun cropUseSuggestion() { _state.update { it.copy(crop = initialCrop()) }; syncGizmo() }

    fun cropUseModelBounds() {
        val b = s.bounds ?: return
        _state.update { it.copy(crop = CropUi(CropGizmo.fromBounds(b), false, "", false)) }
        syncGizmo()
    }

    fun cropSetYaw(deg: Float) {
        val c = s.crop ?: return
        setCropBox(CropGizmo.rotateY(c.box, Math.toRadians((deg - c.yawDeg).toDouble()).toFloat()), deg)
    }

    fun applyCrop() {
        val c = s.crop ?: return
        commit(EditOp.Crop(c.box.center, c.box.rotation, c.box.halfExtents, keepInside = true))
    }

    /** Screen positions of the crop handles: index 0..5 = faces, 6 = centre (move). */
    fun cropHandlePoints(box: OrientedBox): List<Vec3> =
        (0 until CropGizmo.FACE_COUNT).map { CropGizmo.faceCenter(box, it) } + box.center

    // ---- trim ----------------------------------------------------------------------------------

    private fun initialTrim(): TrimUi? {
        val b = s.bounds ?: return null
        val doc = s.doc
        val g = loaded?.extras?.ground
        val diag = b.diagonal
        if (g != null && doc != null) {
            val r = SceneBuilders.currentRotation(doc)
            var n = r.rotate(g.normal).normalized()
            val p = doc.toCurrent(g.point)
            // "above" is the side the model is on
            if (n.dot(b.center - p) < 0f) n = -n
            return TrimUi(n, p, offset = diag * 0.008f, minOffset = -diag * 0.1f, maxOffset = diag * 0.6f, fromGround = true)
        }
        return TrimUi(Vec3.Y, Vec3(b.center.x, b.min.y, b.center.z), offset = 0f, minOffset = -diag * 0.02f,
                      maxOffset = b.size.y, fromGround = false)
    }

    fun trimSetOffset(v: Float) {
        _state.update { st -> st.copy(trim = st.trim?.let { it.copy(offset = v.coerceIn(it.minOffset, it.maxOffset)) }) }
        syncGizmo()
    }

    fun applyTrim() {
        val t = s.trim ?: return
        commit(EditOp.ClipPlane(t.point, t.normal))
    }

    // ---- select & delete -----------------------------------------------------------------------

    fun selectSetLasso(on: Boolean) = _state.update { it.copy(select = it.select.copy(lasso = on, lassoPath = emptyList())) }
    fun selectSetVisibleOnly(on: Boolean) = _state.update { it.copy(select = it.select.copy(visibleOnly = on)) }
    fun selectSetCombine(c: SelectCombine) = _state.update { it.copy(select = it.select.copy(combine = c)) }

    fun selectClear() { selection = null; syncSelection() }

    fun selectInvert() {
        val m = mesh ?: return
        val cur = selection
        selection = BooleanArray(m.faceCount) { cur == null || !cur[it] }
        syncSelection()
    }

    private fun combineSelection(picked: BooleanArray) {
        val m = mesh ?: return
        if (picked.size != m.faceCount) return
        val cur = selection ?: BooleanArray(m.faceCount)
        val add = s.select.combine == SelectCombine.Add
        selection = BooleanArray(m.faceCount) { if (add) cur[it] || picked[it] else cur[it] && !picked[it] }
        syncSelection()
    }

    private fun finishLasso(path: List<Float>) {
        val m = mesh ?: return
        val b = bvh
        if (b == null) { notice("Still preparing the model for selection — try again in a moment."); return }
        if (path.size < 6) return
        val w = controller.width.toFloat(); val h = controller.height.toFloat()
        val ndc = FloatArray(path.size)
        for (i in 0 until path.size / 2) { ndc[2 * i] = 2f * path[2 * i] / w - 1f; ndc[2 * i + 1] = 1f - 2f * path[2 * i + 1] / h }
        val snap = controller.snapshot()
        val visibleOnly = s.select.visibleOnly
        val version = meshVersion
        viewModelScope.launch {
            setBusy("Selecting")
            try {
                val picked = compute { MeshSelection.facesInScreenPolygon(m, b, snap.viewProj, ndc, snap.eye, visibleOnly) }
                if (version == meshVersion) combineSelection(picked)
            } catch (e: CancellationException) { throw e } catch (e: Throwable) {
                notice("Selection failed: ${e.message ?: e.javaClass.simpleName}")
            } finally { setBusy(null) }
        }
    }

    private fun selectPieceAt(x: Float, y: Float) {
        val m = mesh ?: return
        val b = bvh
        if (b == null) { notice("Still preparing the model for selection — try again in a moment."); return }
        val hit = b.raycast(controller.ray(x, y))
        if (hit == null) { notice("Tap on the model to select the connected piece under your finger."); return }
        val version = meshVersion
        viewModelScope.launch {
            setBusy("Selecting piece")
            try {
                val picked = compute {
                    val topo = topology ?: MeshTopology.build(m).also { if (version == meshVersion) topology = it }
                    val seed = BooleanArray(m.faceCount).also { it[hit.face] = true }
                    MeshSelection.growSelectionToComponent(m, seed, topo)
                }
                if (version == meshVersion) combineSelection(picked)
            } catch (e: CancellationException) { throw e } catch (e: Throwable) {
                notice("Selection failed: ${e.message ?: e.javaClass.simpleName}")
            } finally { setBusy(null) }
        }
    }

    fun deleteSelection() {
        val sel = selection ?: return
        if (MeshSelection.count(sel) == 0) return
        commit(EditOp.DeleteFaces.fromMask(sel))
    }

    // ---- stray pieces --------------------------------------------------------------------------

    fun straySetFraction(f: Float) = _state.update { it.copy(stray = it.stray.copy(minAreaFraction = f.coerceIn(0f, 1f))) }

    /** Number of connected pieces that "Remove stray pieces" would delete with the current slider value. */
    fun strayAffected(st: ViewerUiState): Int {
        val areas = st.analysis?.componentAreas ?: return 0
        if (areas.isEmpty()) return 0
        val limit = areas[0] * st.stray.minAreaFraction
        return areas.count { it < limit }
    }

    fun applyRemoveStray() = commit(EditOp.RemoveSmallComponents(s.stray.minAreaFraction))
    fun applyKeepLargest() = commit(EditOp.KeepLargest(1))

    // ---- orientation ---------------------------------------------------------------------------

    private fun commitReorient(op: EditOp.Reorient) {
        val mat = op.matrix()
        commit(op, pivotFix = { p -> Mat4.transformPoint(mat, p) })
    }

    fun centreOnGround() {
        val m = mesh ?: return
        commitReorient(EditEngine.centerOnGround(m))
    }

    /** Quarter turn about a model axis through the centre of the bounding box. */
    fun rotate90(axis: Int, positive: Boolean) {
        val b = s.bounds ?: return
        val a = when (axis) { 0 -> Vec3.X; 1 -> Vec3.Y; else -> Vec3.Z }
        val q = Quat.axisAngle(a, (if (positive) PI / 2 else -PI / 2).toFloat())
        val c = b.center
        commitReorient(EditOp.Reorient(q, c - q.rotate(c), "Rotate ${if (positive) "+" else "−"}90° about ${"XYZ"[axis]}"))
    }

    fun orientSetYaw(deg: Float) = _state.update { it.copy(orient = it.orient.copy(yawDeg = deg)) }

    fun applyYaw() {
        val b = s.bounds ?: return
        val deg = s.orient.yawDeg
        if (kotlin.math.abs(deg) < 0.05f) return
        val q = Quat.axisAngle(Vec3.Y, Math.toRadians(deg.toDouble()).toFloat())
        val c = b.center
        commitReorient(EditOp.Reorient(q, c - q.rotate(c), "Turn ${deg.roundToInt()}° about vertical"))
    }

    fun orientSetPickUp(on: Boolean) = _state.update { it.copy(orient = it.orient.copy(pickUp = on)) }

    private fun setUpFromSurface(x: Float, y: Float) {
        val m = mesh ?: return
        val b = bvh
        if (b == null) { notice("Still preparing the model — try again in a moment."); return }
        val ray = controller.ray(x, y)
        val hit = b.raycast(ray)
        if (hit == null) { notice("Tap a flat part of the model that should face up."); return }
        val radius = (s.bounds?.diagonal ?: 1f) * 0.03f
        viewModelScope.launch {
            val n = compute { averagedNormal(m, hit.point, radius, hit.normal) }
            // the side the user is looking at is the one that should face up
            val up = if (n.dot(ray.dir) > 0f) -n else n
            val q = Quat.fromTo(up, Vec3.Y)
            _state.update { it.copy(orient = it.orient.copy(pickUp = false)) }
            commitReorient(EditOp.Reorient(q, hit.point - q.rotate(hit.point), "Set up direction"))
        }
    }

    private fun averagedNormal(m: Mesh, center: Vec3, radius: Float, fallback: Vec3): Vec3 {
        val mask = MeshSelection.facesInSphere(m, center, radius)
        val pos = m.positions; val idx = m.indices
        var nx = 0.0; var ny = 0.0; var nz = 0.0
        for (f in mask.indices) if (mask[f]) {
            val a = idx[3 * f] * 3; val b = idx[3 * f + 1] * 3; val c = idx[3 * f + 2] * 3
            val e1x = pos[b] - pos[a]; val e1y = pos[b + 1] - pos[a + 1]; val e1z = pos[b + 2] - pos[a + 2]
            val e2x = pos[c] - pos[a]; val e2y = pos[c + 1] - pos[a + 1]; val e2z = pos[c + 2] - pos[a + 2]
            var cx = (e1y * e2z - e1z * e2y).toDouble(); var cy = (e1z * e2x - e1x * e2z).toDouble(); var cz = (e1x * e2y - e1y * e2x).toDouble()
            // count faces on the same side as the tapped one
            if (cx * fallback.x + cy * fallback.y + cz * fallback.z < 0) { cx = -cx; cy = -cy; cz = -cz }
            nx += cx; ny += cy; nz += cz
        }
        val v = Vec3(nx.toFloat(), ny.toFloat(), nz.toFloat())
        return if (v.length() > 1e-12f) v.normalized() else fallback
    }

    // ---- hole repair ---------------------------------------------------------------------------

    private fun chosenHoleIndices(): Set<Int> {
        val h = s.holes
        val limit = h.maxPerimeter
        return if (limit != null) holes.filter { it.perimeter <= limit }.map { it.index }.toSet() else h.selected
    }

    fun holeToggle(index: Int) {
        _state.update { st ->
            val sel = st.holes.selected
            st.copy(holes = st.holes.copy(selected = if (index in sel) sel - index else sel + index, maxPerimeter = null))
        }
        syncHoleLines()
    }

    /** Choose all holes with a perimeter up to [limit] (model units), or go back to individual choice with null. */
    fun holeSetMaxPerimeter(limit: Float?) {
        _state.update { it.copy(holes = it.holes.copy(maxPerimeter = limit)) }
        syncHoleLines()
    }

    fun holeFocus(index: Int) {
        val h = holes.firstOrNull { it.index == index } ?: return
        val cam = controller.camera.value
        val n = if (h.normal.length() > 0.5f) h.normal else -cam.forward
        val yaw = if (hypot(n.x, n.z) < 1e-5f) cam.yaw else atan2(n.x, n.z)
        val pitch = atan2(n.y, hypot(n.x, n.z)).coerceIn(-OrbitCamera.MAX_PITCH, OrbitCamera.MAX_PITCH)
        val size = max(h.perimeter / PI.toFloat(), cam.sceneRadius * 0.02f)
        lookTarget = null
        controller.animateTo(cam.copy(pivot = h.centroid, yaw = yaw, pitch = pitch, roll = 0f).zoom(cam.distance / (size * 3.2f)))
    }

    fun holesRequestFill() {
        if (chosenHoleIndices().isEmpty()) { notice("Choose at least one hole to repair."); return }
        _state.update { it.copy(holes = it.holes.copy(confirming = true)) }
    }

    fun holesCancelFill() = _state.update { it.copy(holes = it.holes.copy(confirming = false)) }

    fun holesConfirmFill() {
        val h = s.holes
        _state.update { it.copy(holes = it.holes.copy(confirming = false)) }
        val limit = h.maxPerimeter
        val op = if (limit != null) EditOp.FillHoles(limit, null)
        else EditOp.FillHoles(Float.MAX_VALUE, holes.filter { it.index in h.selected }.map { it.centroid })
        commit(op)
    }

    // ---- simplify ------------------------------------------------------------------------------

    fun simplifySetFraction(fraction: Float, finished: Boolean) {
        _state.update { it.copy(simplify = it.simplify.copy(fraction = fraction.coerceIn(0.05f, 1f))) }
        if (finished) requestSimplifyPreview()
    }

    private fun restoreDisplayedMesh() {
        val m = mesh ?: return
        previewMesh = null
        previewJob?.cancel()
        previewToken++
        if (displayed !== m) {
            displayed = m
            val version = meshVersion
            viewModelScope.launch {
                val buffers = compute { MeshBuffers.build(m) }
                if (version != meshVersion || displayed !== m) return@launch
                bridge.setMesh(buffers)
                syncSelection(); syncHoleLines()
                if (s.shading == ShadingMode.Wireframe) ensureWire()
            }
        }
        _state.update { it.copy(simplify = it.simplify.copy(preview = null, computing = false, error = null)) }
    }

    private fun requestSimplifyPreview() {
        val m = mesh ?: return
        val fraction = s.simplify.fraction
        val target = max(4, (m.faceCount * fraction).roundToInt())
        previewJob?.cancel()
        val token = ++previewToken
        if (target >= m.faceCount) { restoreDisplayedMesh(); return }
        val scale = s.effectiveScale
        val version = meshVersion
        _state.update { it.copy(simplify = it.simplify.copy(computing = true, error = null)) }
        previewJob = viewModelScope.launch {
            try {
                val out = previewScope.async {
                    if (token != previewToken) return@async null
                    val r = MeshOps.simplify(m, target)
                    if (token != previewToken) return@async null
                    val fwd = MeshOps.deviation(m, r.mesh, samples = 12000)
                    val back = MeshOps.deviation(r.mesh, m, samples = 12000, toBvh = bvh)
                    val dev = if (fwd.p95 >= back.p95) fwd else back
                    Triple(r, dev, MeshBuffers.build(r.mesh))
                }.await() ?: return@launch
                if (token != previewToken || version != meshVersion) return@launch
                val (r, dev, buffers) = out
                previewMesh = r.mesh
                displayed = r.mesh
                bridge.setMesh(buffers)
                bridge.setLines(LINES_HOLES, null)
                if (s.shading == ShadingMode.Wireframe) ensureWire()
                _state.update {
                    it.copy(simplify = it.simplify.copy(computing = false, preview = SimplifyPreview(
                        targetFaces = target, resultFaces = r.faceCount, originalFaces = r.originalFaceCount,
                        targetReached = r.targetReached, deviation = dev,
                        meanText = Measuring.formatModelLength(dev.mean.toDouble(), scale),
                        p95Text = Measuring.formatModelLength(dev.p95.toDouble(), scale))))
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                _state.update {
                    it.copy(simplify = it.simplify.copy(computing = false, preview = null,
                        error = if (e is OutOfMemoryError) "Not enough memory to simplify this model." else "Simplification failed: ${e.message ?: e.javaClass.simpleName}"))
                }
            }
        }
    }

    fun applySimplify() {
        val p = s.simplify.preview ?: return
        val pm = previewMesh ?: return
        // The preview was computed with exactly the engine's call, and the operation is
        // deterministic, so the previewed mesh is the result of the operation.
        commit(EditOp.Simplify(p.targetFaces), precomputed = pm)
    }

    // ---- scale & measurement -------------------------------------------------------------------

    private fun pick(x: Float, y: Float): PickedPoint? {
        val b = bvh ?: return null
        val m = mesh ?: return null
        val hit = b.raycast(controller.ray(x, y)) ?: return null
        return PickedPoint(hit.point, Measuring.pickSigma(m, hit.face, controller.camera.value, controller.height, hit.point))
    }

    private fun refreshMeasurementRows() {
        val doc = s.doc ?: return
        val scale = s.effectiveScale
        val b = bvh
        val diag = s.bounds?.diagonal ?: 1f
        val rows = doc.measurements.map { m ->
            val (a, bb) = EditEngine.displayEndpoints(m, doc)
            MeasurementRow(m, Measuring.label(m, scale), a, bb, offSurface = b != null && Measuring.endpointOffSurface(m, doc, b, diag))
        }
        _state.update { it.copy(measure = it.measure.copy(rows = rows)) }
    }

    private fun placePoint(p: PickedPoint) {
        val doc = s.doc ?: return
        val cal = s.measure.calibration
        if (cal != null) {
            val next = when {
                cal.a == null -> cal.copy(a = p)
                cal.b == null -> cal.copy(b = p, dialogOpen = true, error = null)
                else -> cal.copy(b = p, dialogOpen = true, error = null)
            }
            _state.update { it.copy(measure = it.measure.copy(calibration = next)) }
            return
        }
        val first = s.measure.pending
        if (first == null) {
            _state.update { it.copy(measure = it.measure.copy(pending = p)) }
            return
        }
        if (first.point.distanceTo(p.point) <= 0f) return
        val m = Measurement(UUID.randomUUID().toString(), Measuring.nextName(doc.measurements), doc.toBase(first.point),
                            doc.toBase(p.point), max(first.sigmaUnits, p.sigmaUnits), System.currentTimeMillis())
        _state.update { it.copy(measure = it.measure.copy(pending = null)) }
        commitDoc(doc.copy(measurements = doc.measurements + m))
        refreshMeasurementRows()
    }

    fun cancelPendingPoint() = _state.update { it.copy(measure = it.measure.copy(pending = null)) }

    fun setRenaming(id: String?) = _state.update { it.copy(measure = it.measure.copy(renamingId = id)) }

    fun renameMeasurement(id: String, name: String) {
        val doc = s.doc ?: return
        val clean = name.trim().take(60)
        _state.update { it.copy(measure = it.measure.copy(renamingId = null)) }
        if (clean.isEmpty()) return
        commitDoc(doc.copy(measurements = doc.measurements.map { if (it.id == id) it.copy(name = clean) else it }))
        refreshMeasurementRows()
    }

    fun deleteMeasurement(id: String) {
        val doc = s.doc ?: return
        commitDoc(doc.copy(measurements = doc.measurements.filter { it.id != id }))
        refreshMeasurementRows()
    }

    fun startCalibration() {
        if (s.tool != ToolMode.Measure) setTool(ToolMode.Measure)
        _state.update { it.copy(measure = it.measure.copy(calibration = CalibrationUi(), pending = null)) }
    }

    fun cancelCalibration() = _state.update { it.copy(measure = it.measure.copy(calibration = null)) }
    fun closeCalibrationDialog() =
        _state.update { st -> st.copy(measure = st.measure.copy(calibration = st.measure.calibration?.copy(dialogOpen = false))) }
    fun openCalibrationDialog() =
        _state.update { st -> st.copy(measure = st.measure.copy(calibration = st.measure.calibration?.copy(dialogOpen = true, error = null))) }

    /** Applies the calibration from the two picked points and the typed distance. Returns false (with an error in the state) if refused. */
    fun submitCalibration(distanceText: String, unit: LengthUnit, toleranceText: String): Boolean {
        val doc = s.doc ?: return false
        val cal = s.measure.calibration ?: return false
        val a = cal.a; val b = cal.b
        fun fail(msg: String): Boolean {
            _state.update { st -> st.copy(measure = st.measure.copy(calibration = st.measure.calibration?.copy(error = msg))) }
            return false
        }
        if (a == null || b == null) return fail("Pick two points on the model first.")
        val meters = LengthInput.parseMeters(distanceText, unit) ?: return fail("Enter the real distance as a positive number, for example 12.5.")
        val tol = LengthInput.parseToleranceMeters(toleranceText, unit) ?: return fail("Enter the tolerance as a number, or leave it empty for ±1 mm.")
        val sigma = max(a.sigmaUnits, b.sigmaUnits)
        val result = ScaleCalibration.fromReference(doc.toBase(a.point), doc.toBase(b.point), meters, tol, sigma)
            ?: return fail("This reference is too short to calibrate from: the two points are closer together than about four times " +
                           "the precision with which points can be picked here. Choose points farther apart, or zoom in and pick again.")
        _state.update { it.copy(measure = it.measure.copy(calibration = null)) }
        commitDoc(result.let { doc.copy(scale = it) })
        refreshMeasurementRows()
        syncGrid()
        notice("Scale calibrated ${formatPercentUncertainty(result.relativeUncertainty)}.")
        return true
    }

    fun clearCalibration() {
        val doc = s.doc ?: return
        if (doc.scale == null) return
        commitDoc(doc.copy(scale = null))
        refreshMeasurementRows()
        syncGrid()
        notice("Reference calibration removed.")
    }

    // ---- source cameras ------------------------------------------------------------------------

    private fun refreshCameras() {
        val lm = loaded ?: return
        val doc = s.doc ?: lm.doc
        val cams = lm.cameras
        if (cams == null) { _state.update { it.copy(cameras = CamerasUi(available = false)) }; return }
        val placed = SceneBuilders.placeCameras(cams.cameras, doc)
        val names = session?.frames?.associate { it.id to it.name } ?: emptyMap()
        // the object centre is the origin of the reconstruction frame
        val center = doc.toCurrent(Vec3.ZERO)
        val median = placed.map { it.position.distanceTo(center) }.sorted().let { if (it.isEmpty()) 1f else it[it.size / 2] }
        _state.update {
            it.copy(cameras = it.cameras.copy(
                available = true, placed = placed, unregistered = cams.unregistered, rejected = cams.rejected, frameNames = names,
                coverage = ViewpointCoverage.of(placed.map { p -> p.position }, center), frustumSize = max(median * 0.09f, 1e-6f)))
        }
        syncCameraLines()
    }

    fun selectCamera(id: String?) {
        val lm = loaded
        var photo: CameraPhoto? = null
        if (id != null && lm != null) {
            val ses = session
            val frame = ses?.frames?.firstOrNull { it.id == id }
            val path = if (ses != null && frame != null) try {
                Services.store.frameFile(projectId, ses.id, frame).takeIf { it.isFile }?.absolutePath
            } catch (e: Exception) { null } else null
            photo = CameraPhoto(id, frame?.id, ses?.id, path, frame?.exifOrientation ?: 1)
        }
        _state.update { it.copy(cameras = it.cameras.copy(selectedId = id, photo = photo)) }
        syncCameraLines()
    }

    fun lookFromCamera(id: String) {
        val pc = s.cameras.placed.firstOrNull { it.source.id == id } ?: return
        val b = s.bounds ?: return
        val cam = controller.camera.value
        val ray = dev.pocket3d.core.math.Ray(pc.position, pc.forward.normalized())
        val focus = bvh?.raycast(ray)?.t ?: max((b.center - pc.position).dot(ray.dir), b.diagonal * 0.1f)
        val target = cam.lookFrom(pc.position, pc.rotation, pc.fovYRad, pc.aspect, controller.size.value.aspect, focus)
        lookTarget = target
        _state.update { it.copy(cameras = it.cameras.copy(lookingFromId = id, selectedId = null, photo = it.cameras.photo)) }
        syncCameraLines()
        controller.animateTo(target, 650)
    }

    /** True while the view is exactly the pose of the camera chosen with "Look from this camera". */
    fun isLookingFrom(current: OrbitCamera): Boolean = lookTarget != null && current == lookTarget

    fun stopLookingFrom() {
        lookTarget = null
        _state.update { it.copy(cameras = it.cameras.copy(lookingFromId = null, overlayAlpha = 0f)) }
        controller.fit()
    }

    fun setOverlayAlpha(a: Float) = _state.update { it.copy(cameras = it.cameras.copy(overlayAlpha = a.coerceIn(0f, 1f))) }

    // ---- export --------------------------------------------------------------------------------

    fun setExportFormat(f: ExportFormat) = _state.update { it.copy(export = it.export.copy(format = f, outcome = null)) }
    fun clearExportOutcome() = _state.update { it.copy(export = it.export.copy(outcome = null)) }
    fun shareHandled() = _state.update { it.copy(export = it.export.copy(share = null)) }

    fun suggestedExportName(): String = "${ExportBuilder.safeBaseName(s.title)}.${s.export.format.extension}"

    private fun runExport(destination: Uri?) {
        val m = mesh ?: return
        val doc = s.doc ?: return
        val lm = loaded ?: return
        if (s.export.stage != null) return
        val format = s.export.format
        val scale = s.effectiveScale
        val title = s.title
        exportJob = viewModelScope.launch {
            fun stage(text: String?) = _state.update { it.copy(export = it.export.copy(stage = text)) }
            stage("Preparing")
            _state.update { it.copy(export = it.export.copy(outcome = null)) }
            try {
                val artifact = compute {
                    ExportBuilder.build(format, m, lm.glb.extras, doc, scale, title, System.currentTimeMillis() / 1000) { st -> stage(st) }
                }
                stage("Writing ${artifact.fileName}")
                var shareUri: Uri? = null
                val readBack = withContext(Dispatchers.IO) {
                    if (destination != null) ExportIo.writeToDocument(appContext, destination, artifact.bytes)
                    else {
                        val (file, back) = ExportIo.writeToShareCache(appContext, artifact.fileName, artifact.bytes)
                        shareUri = ExportIo.shareUri(appContext, file)
                        back
                    }
                }
                stage("Verifying")
                when (val check = compute { ExportVerifier.verify(artifact, readBack) }) {
                    is ExportCheck.Ok -> {
                        val uri = shareUri
                        _state.update {
                            it.copy(export = it.export.copy(
                                outcome = ExportOutcome.Success(artifact.fileName, check.summary, artifact.unitsStatement, shared = uri != null),
                                share = uri?.let { u -> ShareRequest(u, format.mimeType, artifact.fileName, ++noticeId) }))
                        }
                    }
                    is ExportCheck.Failed -> {
                        if (destination != null) withContext(Dispatchers.IO) { ExportIo.deleteDocument(appContext, destination) }
                        _state.update {
                            it.copy(export = it.export.copy(outcome = ExportOutcome.Failure(
                                "The export was written but failed verification and should not be used. ${check.reason}")))
                        }
                    }
                }
            } catch (e: CancellationException) {
                if (destination != null) withContext(NonCancellable + Dispatchers.IO) { ExportIo.deleteDocument(appContext, destination) }
                throw e
            } catch (e: ExportIoException) {
                _state.update { it.copy(export = it.export.copy(outcome = ExportOutcome.Failure(e.message ?: "Writing the export failed."))) }
            } catch (e: OutOfMemoryError) {
                _state.update { it.copy(export = it.export.copy(outcome = ExportOutcome.Failure("Not enough memory to export this model. Simplify it first or export as PLY."))) }
            } catch (e: Exception) {
                _state.update { it.copy(export = it.export.copy(outcome = ExportOutcome.Failure("Export failed: ${e.message ?: e.javaClass.simpleName}"))) }
            } finally {
                stage(null)
            }
        }
    }

    /** "Save to…": streams the export to the document the user created. */
    fun exportToDocument(uri: Uri) = runExport(uri)

    /** "Share": writes into the app cache and asks the screen to open the share chooser. */
    fun exportShare() = runExport(null)

    fun cancelExport() {
        exportJob?.cancel()
        _state.update { it.copy(export = it.export.copy(stage = null)) }
    }

    // ---- thumbnail -----------------------------------------------------------------------------

    private fun scheduleThumbnail(delayMs: Long) {
        thumbnailJob?.cancel()
        thumbnailJob = viewModelScope.launch {
            delay(delayMs)
            bridge.caps.first { it != null }
            // wait for the mesh that is being prepared and for its textures
            while (s.busy != null || previewMesh != null) delay(300)
            delay(150)
            bridge.awaitTextures()
            val b = s.bounds ?: return@launch
            val version = meshVersion
            val png = Thumbnail.render(bridge, b) ?: return@launch
            if (version != meshVersion || previewMesh != null) return@launch
            try { Services.store.saveThumbnail(projectId, modelId, png) } catch (e: Exception) {
                if (e is CancellationException) throw e
            }
        }
    }

    // ---- viewport input ------------------------------------------------------------------------

    private val handleRadiusPx: Float get() = 30f * dp

    override fun onTap(x: Float, y: Float) {
        val st = s
        if (!st.ready) return
        when {
            st.tool == ToolMode.Measure -> {
                val p = pick(x, y)
                if (p == null) notice(if (bvh == null) "Still preparing the model — try again in a moment." else "Tap on the model surface to place a point.")
                else placePoint(p)
            }
            st.tool == ToolMode.Edit && st.editTool == EditTool.Select -> selectPieceAt(x, y)
            st.tool == ToolMode.Edit && st.editTool == EditTool.Orient && st.orient.pickUp -> setUpFromSurface(x, y)
            st.showCameras && st.cameras.placed.isNotEmpty() -> {
                val i = CameraPicker.pick(st.cameras.placed, controller.camera.value, controller.width, controller.height, x, y,
                                          st.cameras.frustumSize, handleRadiusPx)
                if (i != null) selectCamera(st.cameras.placed[i].source.id)
            }
        }
    }

    override fun onDoubleTap(x: Float, y: Float) {
        if (!s.ready) return
        val b = bvh
        if (b == null) { notice("Still preparing the model — try again in a moment."); return }
        val hit = b.raycast(controller.ray(x, y))
        if (hit == null) { notice("Double-tap on the model to orbit around that point."); return }
        lookTarget = null
        controller.setPivot(hit.point)
    }

    override fun onLongPress(x: Float, y: Float): Boolean {
        if (s.tool != ToolMode.Measure || !s.ready) return false
        val p = pick(x, y) ?: return false
        drag = Drag.NewPoint
        _state.update { it.copy(measure = it.measure.copy(candidate = p)) }
        setLoupe(loupeAt(x, y))
        return true
    }

    private fun near(p: Vec3, x: Float, y: Float): Float {
        val sp = controller.project(p) ?: return Float.MAX_VALUE
        return hypot(sp.x - x, sp.y - y)
    }

    override fun onToolDragStart(x: Float, y: Float): Boolean {
        val st = s
        if (!st.ready || st.busy != null) return false
        if (st.tool == ToolMode.Edit && st.editTool == EditTool.Crop && st.crop != null) {
            val box = st.crop.box
            var best = -1; var bestD = handleRadiusPx
            val pts = cropHandlePoints(box)
            for (i in pts.indices) { val d = near(pts[i], x, y); if (d < bestD) { bestD = d; best = i } }
            if (best < 0) return false
            val ray = controller.ray(x, y)
            drag = if (best < CropGizmo.FACE_COUNT) Drag.CropFace(best, box, CropGizmo.grabOffset(box, best, ray))
            else {
                val p = CropGizmo.horizontalPlanePoint(ray, box.center.y) ?: return false
                Drag.CropMove(box, box.center - p)
            }
            return true
        }
        if (st.tool == ToolMode.Edit && st.editTool == EditTool.Select && st.select.lasso) {
            drag = Drag.Lasso
            _state.update { it.copy(select = it.select.copy(lassoPath = listOf(x, y))) }
            return true
        }
        if (st.tool == ToolMode.Measure) {
            var bestD = handleRadiusPx
            var found: Drag? = null
            val cal = st.measure.calibration
            if (cal != null) {
                cal.a?.let { val d = near(it.point, x, y); if (d < bestD) { bestD = d; found = Drag.CalibEnd(true) } }
                cal.b?.let { val d = near(it.point, x, y); if (d < bestD) { bestD = d; found = Drag.CalibEnd(false) } }
            } else {
                st.measure.pending?.let { val d = near(it.point, x, y); if (d < bestD) { bestD = d; found = Drag.Pending } }
                for (r in st.measure.rows) {
                    val da = near(r.a, x, y); if (da < bestD) { bestD = da; found = Drag.MeasureEnd(r.measurement.id, true, r.measurement) }
                    val db = near(r.b, x, y); if (db < bestD) { bestD = db; found = Drag.MeasureEnd(r.measurement.id, false, r.measurement) }
                }
            }
            drag = found ?: return false
            setLoupe(loupeAt(x, y))
            return true
        }
        return false
    }

    override fun onToolDrag(x: Float, y: Float) {
        when (val d = drag) {
            is Drag.CropFace -> {
                val minHalf = CropGizmo.minHalfExtent(s.bounds ?: return)
                setCropBox(CropGizmo.dragFace(d.start, d.face, controller.ray(x, y), d.grab, minHalf))
            }
            is Drag.CropMove -> setCropBox(CropGizmo.dragMove(d.start, controller.ray(x, y), d.delta))
            Drag.Lasso -> {
                val path = s.select.lassoPath
                val n = path.size
                if (n >= 2 && hypot(path[n - 2] - x, path[n - 1] - y) < 3f * dp) return
                _state.update { it.copy(select = it.select.copy(lassoPath = path + x + y)) }
            }
            Drag.NewPoint -> {
                setLoupe(loupeAt(x, y))
                pick(x, y)?.let { p -> _state.update { it.copy(measure = it.measure.copy(candidate = p)) } }
            }
            Drag.Pending -> {
                setLoupe(loupeAt(x, y))
                pick(x, y)?.let { p -> _state.update { it.copy(measure = it.measure.copy(pending = p)) } }
            }
            is Drag.CalibEnd -> {
                setLoupe(loupeAt(x, y))
                val p = pick(x, y) ?: return
                _state.update { st ->
                    st.copy(measure = st.measure.copy(calibration = st.measure.calibration?.let { c -> if (d.isA) c.copy(a = p) else c.copy(b = p) }))
                }
            }
            is Drag.MeasureEnd -> {
                setLoupe(loupeAt(x, y))
                val p = pick(x, y) ?: return
                val doc = s.doc ?: return
                val base = doc.toBase(p.point)
                val sigma = max(p.sigmaUnits, d.original.pickSigmaUnits)
                val updated = doc.copy(measurements = doc.measurements.map { m ->
                    if (m.id != d.id) m else if (d.endA) m.copy(a = base, pickSigmaUnits = sigma) else m.copy(b = base, pickSigmaUnits = sigma)
                })
                // live update; saved when the finger lifts
                _state.update { it.copy(doc = updated) }
                refreshMeasurementRows()
            }
            null -> {}
        }
    }

    override fun onToolDragEnd(commit: Boolean) {
        val d = drag
        drag = null
        setLoupe(null)
        when (d) {
            Drag.Lasso -> {
                val path = s.select.lassoPath
                _state.update { it.copy(select = it.select.copy(lassoPath = emptyList())) }
                if (commit) finishLasso(path)
            }
            Drag.NewPoint -> {
                val c = s.measure.candidate
                _state.update { it.copy(measure = it.measure.copy(candidate = null)) }
                if (commit && c != null) placePoint(c)
            }
            is Drag.MeasureEnd -> {
                val doc = s.doc ?: return
                if (commit) commitDoc(doc)
                else {
                    // interrupted: put the endpoint back
                    _state.update { it.copy(doc = doc.copy(measurements = doc.measurements.map { m -> if (m.id == d.id) d.original else m })) }
                }
                refreshMeasurementRows()
            }
            is Drag.CropFace -> if (!commit) setCropBox(d.start)
            is Drag.CropMove -> if (!commit) setCropBox(d.start)
            is Drag.CalibEnd -> if (commit && s.measure.calibration?.let { it.a != null && it.b != null } == true) openCalibrationDialog()
            Drag.Pending, null -> {}
        }
    }

    private companion object {
        const val LINES_HOLES = "holes"
        const val LINES_CAMERAS = "cameras"
        const val LINES_GIZMO = "gizmo"
        val COLOR_HOLE = 0xFFFF7043.toInt()
        val COLOR_HOLE_CHOSEN = 0xFF40C4FF.toInt()
        val COLOR_CAMERA = 0xFF7CC4FF.toInt()
        val COLOR_CAMERA_SELECTED = 0xFFFFC857.toInt()
        val COLOR_GIZMO = 0xFFFFFFFF.toInt()
        val COLOR_PLANE = 0xFFFFC857.toInt()
    }
}
