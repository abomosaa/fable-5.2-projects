package dev.pocket3d.viewer

import android.net.Uri
import dev.pocket3d.core.capture.CoverageGrid
import dev.pocket3d.core.edit.EditDocument
import dev.pocket3d.core.edit.Measurement
import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.mesh.Aabb
import dev.pocket3d.core.mesh.DeviationStats
import dev.pocket3d.core.mesh.MeshStats
import dev.pocket3d.core.mesh.OrientedBox
import dev.pocket3d.core.project.ModelVersion
import dev.pocket3d.core.project.UnregisteredFrame
import dev.pocket3d.core.scale.ScaleCalibration
import dev.pocket3d.viewer.data.Diagnostics
import dev.pocket3d.viewer.data.ModelExtras
import dev.pocket3d.viewer.export.ExportFormat
import dev.pocket3d.viewer.gl.BackgroundStyle
import dev.pocket3d.viewer.gl.Loupe
import dev.pocket3d.viewer.gl.ShadingMode
import dev.pocket3d.viewer.gl.TextureReport
import dev.pocket3d.viewer.measure.ScaleStatus
import dev.pocket3d.viewer.scene.EvidenceStats
import dev.pocket3d.viewer.scene.HoleEntry
import dev.pocket3d.viewer.scene.PlacedCamera

enum class ToolMode(val label: String) { View("View"), Edit("Edit"), Measure("Measure"), Cameras("Cameras"), Export("Export") }

enum class EditTool(val label: String) {
    Crop("Crop"), Trim("Trim"), Select("Select"), Stray("Stray pieces"), Orient("Orient"), Holes("Repair holes"), Simplify("Simplify")
}

sealed interface LoadState {
    data class Loading(val message: String) : LoadState
    data class Failed(val title: String, val detail: String) : LoadState
    data object Ready : LoadState
}

/** A heavy operation in progress. */
data class Busy(val label: String, val cancellable: Boolean = true)

/** A one-line message for the user (snackbar). [id] makes repeated identical messages distinct. */
data class Notice(val text: String, val id: Long)

/** Numbers computed in the background for the current mesh. */
data class MeshAnalysis(
    val stats: MeshStats,
    val evidence: EvidenceStats,
    val holes: List<HoleEntry>,
    /** Total length of all open boundaries, model units. */
    val boundaryLength: Float,
    /** Surface area per connected piece, largest first. */
    val componentAreas: List<Float>,
)

data class CropUi(
    val box: OrientedBox,
    val fromSuggestion: Boolean,
    val basis: String,
    val uncertain: Boolean,
    /** Rotation about the vertical applied by the user on top of the starting box, degrees. */
    val yawDeg: Float = 0f,
)

data class TrimUi(
    /** Unit normal; the side it points to is kept. */
    val normal: Vec3,
    /** Point on the plane at offset 0. */
    val base: Vec3,
    val offset: Float,
    val minOffset: Float,
    val maxOffset: Float,
    /** True when the plane starts from the support surface the reconstruction detected. */
    val fromGround: Boolean,
) {
    val point: Vec3 get() = base + normal * offset
}

enum class SelectCombine(val label: String) { Add("Add"), Subtract("Subtract") }

data class SelectUi(
    val lasso: Boolean = true,
    val visibleOnly: Boolean = true,
    val combine: SelectCombine = SelectCombine.Add,
    val selectedFaces: Int = 0,
    /** Lasso being drawn: x, y pairs in viewport pixels. */
    val lassoPath: List<Float> = emptyList(),
)

data class StrayUi(val minAreaFraction: Float = 0.01f)

data class OrientUi(val pickUp: Boolean = false, val yawDeg: Float = 0f)

data class HolesUi(
    /** Hole indices chosen individually. */
    val selected: Set<Int> = emptySet(),
    /** "All smaller than" limit in model units, or null when choosing individually. */
    val maxPerimeter: Float? = null,
    val confirming: Boolean = false,
)

data class SimplifyPreview(
    val targetFaces: Int,
    val resultFaces: Int,
    val originalFaces: Int,
    val targetReached: Boolean,
    /** Larger of the two one-sided deviations (original → simplified, simplified → original). */
    val deviation: DeviationStats,
    /** Deviation in words, through the one length formatter. */
    val meanText: String,
    val p95Text: String,
)

data class SimplifyUi(
    /** Target as a fraction of the current face count. */
    val fraction: Float = 0.5f,
    val computing: Boolean = false,
    val preview: SimplifyPreview? = null,
    val error: String? = null,
)

/** A surface point picked in the viewport, CURRENT coordinates. */
data class PickedPoint(val point: Vec3, val sigmaUnits: Double)

data class MeasurementRow(
    val measurement: Measurement,
    /** `EditEngine.measure(m, effectiveScale).format()` — the only formatting path. */
    val label: String,
    /** Endpoints in CURRENT coordinates. */
    val a: Vec3,
    val b: Vec3,
    val offSurface: Boolean,
)

data class CalibrationUi(
    val a: PickedPoint? = null,
    val b: PickedPoint? = null,
    val dialogOpen: Boolean = false,
    val error: String? = null,
)

data class MeasureUi(
    val rows: List<MeasurementRow> = emptyList(),
    /** First point of a measurement that is being placed. */
    val pending: PickedPoint? = null,
    /** Point under the finger during a press-and-hold placement (not placed yet). */
    val candidate: PickedPoint? = null,
    val calibration: CalibrationUi? = null,
    val renamingId: String? = null,
)

data class CameraPhoto(val cameraId: String, val frameId: String?, val sessionId: String?, val filePath: String?, val exifOrientation: Int)

data class CamerasUi(
    val available: Boolean = false,
    val placed: List<PlacedCamera> = emptyList(),
    val unregistered: List<UnregisteredFrame> = emptyList(),
    val rejected: List<UnregisteredFrame> = emptyList(),
    /** Frame id → display name of the photo. */
    val frameNames: Map<String, String> = emptyMap(),
    val coverage: CoverageGrid? = null,
    val selectedId: String? = null,
    /** Camera whose pose the view currently reproduces. */
    val lookingFromId: String? = null,
    val photo: CameraPhoto? = null,
    val overlayAlpha: Float = 0f,
    val frustumSize: Float = 0.05f,
)

sealed interface ExportOutcome {
    data class Success(val fileName: String, val summary: String, val unitsStatement: String, val shared: Boolean) : ExportOutcome
    data class Failure(val message: String) : ExportOutcome
}

/** One-shot request for the screen to open the system share chooser. */
data class ShareRequest(val uri: Uri, val mimeType: String, val title: String, val id: Long)

data class ExportUi(
    val format: ExportFormat = ExportFormat.GLB,
    val stage: String? = null,
    val outcome: ExportOutcome? = null,
    val share: ShareRequest? = null,
)

data class ViewerUiState(
    val load: LoadState = LoadState.Loading("Opening model…"),
    val title: String = "Model",
    val model: ModelVersion? = null,
    val doc: EditDocument? = null,
    val effectiveScale: ScaleCalibration? = null,
    val scaleStatus: ScaleStatus = ScaleStatus.of(null, null),
    val extras: ModelExtras = ModelExtras(),
    val diagnostics: Diagnostics? = null,
    val loadNotes: List<String> = emptyList(),

    val tool: ToolMode = ToolMode.View,
    val editTool: EditTool = EditTool.Crop,
    val shading: ShadingMode = ShadingMode.Textured,
    val background: BackgroundStyle = BackgroundStyle.Dark,
    val showGrid: Boolean = false,
    val showAxes: Boolean = true,
    val showHoles: Boolean = false,
    val showCameras: Boolean = false,
    val gridStepText: String? = null,
    val hasConfidence: Boolean = false,
    val hasTextures: Boolean = false,

    val meshVersion: Int = 0,
    val faceCount: Int = 0,
    val vertexCount: Int = 0,
    val bounds: Aabb? = null,
    val pickingReady: Boolean = false,
    val analysis: MeshAnalysis? = null,
    val textures: TextureReport? = null,

    val busy: Busy? = null,
    val notice: Notice? = null,
    val glError: String? = null,
    val loupe: Loupe? = null,
    val confirmReset: Boolean = false,

    val crop: CropUi? = null,
    val trim: TrimUi? = null,
    val select: SelectUi = SelectUi(),
    val stray: StrayUi = StrayUi(),
    val orient: OrientUi = OrientUi(),
    val holes: HolesUi = HolesUi(),
    val simplify: SimplifyUi = SimplifyUi(),
    val measure: MeasureUi = MeasureUi(),
    val cameras: CamerasUi = CamerasUi(),
    val export: ExportUi = ExportUi(),
) {
    val ready: Boolean get() = load is LoadState.Ready
    val undoLabel: String? get() = doc?.ops?.lastOrNull()?.label
    val redoLabel: String? get() = doc?.redo?.lastOrNull()?.label
}
