package dev.pocket3d.viewer

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.mesh.Aabb
import dev.pocket3d.core.project.UnregisteredFrame
import dev.pocket3d.core.services.Services
import dev.pocket3d.design.InfoBanner
import dev.pocket3d.design.LabeledValue
import dev.pocket3d.design.SectionTitle
import dev.pocket3d.design.StatusPill
import dev.pocket3d.design.Tone
import dev.pocket3d.viewer.camera.StandardView
import dev.pocket3d.viewer.camera.ViewportController
import dev.pocket3d.viewer.data.CamerasJson
import dev.pocket3d.viewer.data.SparsePreview
import dev.pocket3d.viewer.gl.SceneBridge
import dev.pocket3d.viewer.scene.LineBuilder
import dev.pocket3d.viewer.scene.SceneBuilders
import dev.pocket3d.viewer.ui.Hint
import dev.pocket3d.viewer.ui.Viewport3D
import dev.pocket3d.viewer.ui.ViewportInput
import dev.pocket3d.viewer.ui.formatCount
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.math.max

const val SPARSE_PREVIEW_BANNER =
    "Provisional preview from the companion: sparse tie points and camera positions only — not the final surface."

/** Scene content of a sparse preview, in the form the renderer takes. Pure, so it is unit tested. */
class SparseScene(
    /** Interleaved xyz + rgb (0..1) per point. */
    val points: FloatArray,
    val frusta: LineBuilder,
    val guides: LineBuilder,
    /** Thin ground-grid lines (GL_LINES), or null when the companion found no support plane. */
    val grid: FloatArray?,
    /** Bounds to frame: the object sphere and the cameras. */
    val bounds: Aabb,
    val frustumSize: Float,
) {
    companion object {
        private const val COLOR_FRUSTUM = 0xFF7CC4FF.toInt()
        private const val COLOR_SPHERE = 0xFFB8A6FF.toInt()

        fun build(p: SparsePreview): SparseScene {
            val n = p.pointCount
            val pts = FloatArray(n * 6)
            val hasColor = p.colors.size == n * 3
            for (i in 0 until n) {
                pts[6 * i] = p.points[3 * i]; pts[6 * i + 1] = p.points[3 * i + 1]; pts[6 * i + 2] = p.points[3 * i + 2]
                if (hasColor) {
                    pts[6 * i + 3] = (p.colors[3 * i].toInt() and 0xff) / 255f
                    pts[6 * i + 4] = (p.colors[3 * i + 1].toInt() and 0xff) / 255f
                    pts[6 * i + 5] = (p.colors[3 * i + 2].toInt() and 0xff) / 255f
                } else { pts[6 * i + 3] = 0.8f; pts[6 * i + 4] = 0.8f; pts[6 * i + 5] = 0.8f }
            }
            val placed = SceneBuilders.placeCameras(p.cameras, null)
            val center = p.objectCenter
            val dists = placed.map { it.position.distanceTo(center) }.sorted()
            val median = if (dists.isEmpty()) max(p.objectRadius * 3f, 1f) else dists[dists.size / 2]
            val frustumSize = max(median * 0.09f, 1e-6f)
            val frusta = SceneBuilders.frusta(placed, frustumSize, COLOR_FRUSTUM, null, COLOR_FRUSTUM)
            val guides = LineBuilder()
            if (p.objectRadius > 0f) SceneBuilders.addSphere(guides, center, p.objectRadius, COLOR_SPHERE)

            // frame the object and the cameras (not stray far-away tie points)
            var r = max(p.objectRadius, 1e-4f)
            for (d in dists) r = max(r, d + frustumSize)
            if (placed.isEmpty() && p.objectRadius <= 0f && n > 0) {
                val b = Aabb.of(p.points)
                return SparseScene(pts, frusta, guides, null, b, frustumSize)
            }
            val bounds = Aabb(center - Vec3(r, r, r) * 0.6f, center + Vec3(r, r, r) * 0.6f)
            val grid = p.ground?.let { g ->
                val foot = center - g.normal * g.signedDistance(center)
                val extent = max(p.objectRadius * 3f, r)
                SceneBuilders.grid(foot, g.normal, extent, SceneBuilders.niceStep(extent * 2f))
            }
            return SparseScene(pts, frusta, guides, grid, bounds, frustumSize)
        }
    }
}

sealed interface SparseLoad {
    data object Loading : SparseLoad
    data class Failed(val title: String, val detail: String) : SparseLoad
    data object Ready : SparseLoad
}

data class SparseUiState(
    val load: SparseLoad = SparseLoad.Loading,
    val pointCount: Int = 0,
    val totalPoints: Int = 0,
    val registered: Int = 0,
    val unregistered: List<UnregisteredFrame> = emptyList(),
    val units: String = "arbitrary",
    val hasGround: Boolean = false,
    val objectRadius: Float = 0f,
    val showCameras: Boolean = true,
    val showGuides: Boolean = true,
    val largePoints: Boolean = false,
    val glError: String? = null,
)

class SparsePreviewViewModel(private val projectId: String, private val jobId: String, private val density: Float) : ViewModel() {
    val bridge = SceneBridge(viewModelScope)
    val controller = ViewportController(viewModelScope) { bridge.setCamera(it) }
    private val _state = MutableStateFlow(SparseUiState())
    val state: StateFlow<SparseUiState> = _state
    private var scene: SparseScene? = null
    val input = object : ViewportInput {
        override fun onDoubleTap(x: Float, y: Float) { controller.fit() }
    }

    init {
        viewModelScope.launch { bridge.error.collect { e -> _state.update { it.copy(glError = e) } } }
        load()
    }

    fun load() {
        viewModelScope.launch {
            _state.update { SparseUiState() }
            try {
                val file = try { File(Services.store.jobDir(projectId, jobId), "sparse_preview.json") }
                catch (e: UninitializedPropertyAccessException) {
                    _state.update { it.copy(load = SparseLoad.Failed("Storage is not available", "The app's project storage has not been started.")) }
                    return@launch
                }
                if (!file.isFile) {
                    _state.update { it.copy(load = SparseLoad.Failed("No preview yet",
                        "The companion has not sent a sparse preview for this reconstruction. It appears once the camera positions have been solved.")) }
                    return@launch
                }
                val (preview, built) = withContext(Dispatchers.Default) {
                    val p = SparsePreview.parse(withContext(Dispatchers.IO) { file.readText() })
                    p to SparseScene.build(p)
                }
                scene = built
                bridge.updateSettings { it.copy(showGrid = built.grid != null, pointSizePx = 2.5f * density) }
                bridge.setPoints(built.points)
                bridge.setGrid(built.grid)
                syncLines()
                controller.setScene(built.bounds, reset = true)
                _state.update {
                    it.copy(load = SparseLoad.Ready, pointCount = preview.pointCount, totalPoints = preview.totalPointsInModel,
                            registered = preview.cameras.size, unregistered = preview.unregistered, units = preview.units,
                            hasGround = preview.ground != null, objectRadius = preview.objectRadius)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: IllegalArgumentException) {
                _state.update { it.copy(load = SparseLoad.Failed("The preview file is damaged", e.message ?: "It could not be read.")) }
            } catch (e: OutOfMemoryError) {
                _state.update { it.copy(load = SparseLoad.Failed("Not enough memory", "The preview is too large to show on this device.")) }
            } catch (e: Exception) {
                _state.update { it.copy(load = SparseLoad.Failed("The preview could not be opened", e.message ?: e.javaClass.simpleName)) }
            }
        }
    }

    private fun syncLines() {
        val s = scene ?: return
        val st = _state.value
        bridge.setLines("cameras", if (st.showCameras) s.frusta.build(1.6f * density) else null)
        bridge.setLines("guides", if (st.showGuides) s.guides.build(1.6f * density) else null)
        bridge.updateSettings { it.copy(showGrid = st.showGuides && s.grid != null, pointSizePx = (if (st.largePoints) 5f else 2.5f) * density) }
    }

    fun setShowCameras(on: Boolean) { _state.update { it.copy(showCameras = on) }; syncLines() }
    fun setShowGuides(on: Boolean) { _state.update { it.copy(showGuides = on) }; syncLines() }
    fun setLargePoints(on: Boolean) { _state.update { it.copy(largePoints = on) }; syncLines() }
}

/**
 * Provisional sparse preview of a running reconstruction: the structure-from-motion tie points,
 * the solved camera positions and the companion's estimate of where the object is. Explicitly
 * not a surface.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun SparsePreviewScreen(projectId: String, jobId: String, onBack: () -> Unit) {
    val density = LocalDensity.current.density
    val vm: SparsePreviewViewModel = viewModel(
        key = "sparse/$projectId/$jobId",
        factory = viewModelFactory { initializer { SparsePreviewViewModel(projectId, jobId, density) } },
    )
    val state by vm.state.collectAsStateWithLifecycle()
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Sparse preview", style = MaterialTheme.typography.titleMedium)
                        StatusPill("PROVISIONAL", Tone.Provisional)
                    }
                },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") } },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            // persistent: visible in every state of this screen
            InfoBanner(SPARSE_PREVIEW_BANNER, tone = Tone.Provisional, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
            when (val load = state.load) {
                SparseLoad.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator(); Spacer(Modifier.height(12.dp)); Text("Reading preview…")
                    }
                }
                is SparseLoad.Failed -> Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center) {
                    InfoBanner(load.title, body = load.detail, tone = Tone.Bad)
                    Row(Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { vm.load() }) { Text("Try again") }
                        OutlinedButton(onClick = onBack) { Text("Back") }
                    }
                }
                SparseLoad.Ready -> {
                    Viewport3D(vm.bridge, vm.controller, vm.input,
                               "Provisional 3D preview: ${state.pointCount} sparse points and ${state.registered} camera positions. Drag to orbit, pinch to zoom.",
                               Modifier.weight(1f).fillMaxWidth()) {
                        state.glError?.let { err ->
                            Surface(Modifier.align(Alignment.Center).padding(20.dp), tonalElevation = 6.dp, shape = MaterialTheme.shapes.medium) {
                                Column(Modifier.padding(16.dp)) {
                                    InfoBanner("The 3D view could not be drawn", tone = Tone.Bad)
                                    Text(err, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall,
                                         modifier = Modifier.padding(top = 8.dp).heightIn(max = 200.dp).verticalScroll(rememberScrollState()))
                                }
                            }
                        }
                    }
                    Surface(tonalElevation = 2.dp) {
                        Column(Modifier.fillMaxWidth().heightIn(max = 300.dp).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 10.dp)) {
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                FilledTonalButton(onClick = { vm.controller.fit() }) { Text("Fit to view") }
                                OutlinedButton(onClick = { vm.controller.standardView(StandardView.Top) }) { Text("Top") }
                                FilterChip(state.showCameras, { vm.setShowCameras(!state.showCameras) }, label = { Text("Cameras") })
                                FilterChip(state.showGuides, { vm.setShowGuides(!state.showGuides) }, label = { Text("Object estimate") })
                                FilterChip(state.largePoints, { vm.setLargePoints(!state.largePoints) }, label = { Text("Larger points") })
                            }
                            val total = state.registered + state.unregistered.size
                            LabeledValue("Photos registered so far", "${state.registered} of $total",
                                         tone = if (state.unregistered.isNotEmpty()) Tone.Warn else Tone.Good)
                            LabeledValue("Photos not registered", formatCount(state.unregistered.size),
                                         tone = if (state.unregistered.isNotEmpty()) Tone.Warn else Tone.Neutral)
                            LabeledValue("Sparse tie points shown", if (state.totalPoints > state.pointCount)
                                "${formatCount(state.pointCount)} of ${formatCount(state.totalPoints)}" else formatCount(state.pointCount))
                            LabeledValue("Units", if (state.units == "meters") "metres (AR-estimated)" else "arbitrary (no real-world scale)")
                            Hint("Blue pyramids are solved camera positions. The violet circles are the companion's estimate of where the object is" +
                                 (if (state.hasGround) "; the grid is the estimated support surface" else "; no support surface was found yet") +
                                 ". The dense surface, texture and evidence values do not exist yet.")
                            if (state.unregistered.isNotEmpty()) {
                                SectionTitle("Not registered (${state.unregistered.size})")
                                for (u in state.unregistered.take(40)) LabeledValue("Photo ${u.id}", CamerasJson.describeReason(u.reason), tone = Tone.Warn)
                                if (state.unregistered.size > 40) Hint("…and ${state.unregistered.size - 40} more.")
                            }
                        }
                    }
                }
            }
        }
    }
}
