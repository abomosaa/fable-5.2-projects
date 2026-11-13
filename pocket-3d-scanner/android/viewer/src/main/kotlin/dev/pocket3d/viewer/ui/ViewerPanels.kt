package dev.pocket3d.viewer.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Redo
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.outlined.CenterFocusStrong
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.IosShare
import androidx.compose.material.icons.outlined.SaveAlt
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.pocket3d.core.project.FrameFlag
import dev.pocket3d.design.InfoBanner
import dev.pocket3d.design.LabeledValue
import dev.pocket3d.design.NumericStyle
import dev.pocket3d.design.SectionTitle
import dev.pocket3d.design.StatusPill
import dev.pocket3d.design.Tone
import dev.pocket3d.viewer.EditTool
import dev.pocket3d.viewer.ExportOutcome
import dev.pocket3d.viewer.SelectCombine
import dev.pocket3d.viewer.ViewerUiState
import dev.pocket3d.viewer.ViewerViewModel
import dev.pocket3d.viewer.camera.OrbitCamera
import dev.pocket3d.viewer.camera.StandardView
import dev.pocket3d.viewer.data.CamerasJson
import dev.pocket3d.viewer.export.ExportBuilder
import dev.pocket3d.viewer.export.ExportFormat
import dev.pocket3d.viewer.gl.BackgroundStyle
import dev.pocket3d.viewer.gl.ShadingMode
import dev.pocket3d.viewer.measure.Measuring
import dev.pocket3d.viewer.scene.HoleList
import dev.pocket3d.viewer.scene.ViewpointCoverage
import kotlin.math.log10
import kotlin.math.pow
import kotlin.math.roundToInt

private val PanelPadding = Modifier.padding(horizontal = 16.dp)

// ---- View ----------------------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun ViewPanel(state: ViewerUiState, vm: ViewerViewModel, onShowStats: () -> Unit) {
    Column(PanelPadding.padding(vertical = 12.dp)) {
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            val modes = ShadingMode.entries
            modes.forEachIndexed { i, mode ->
                SegmentedButton(
                    selected = state.shading == mode,
                    onClick = { vm.setShading(mode) },
                    enabled = mode != ShadingMode.Evidence || state.hasConfidence,
                    shape = SegmentedButtonDefaults.itemShape(i, modes.size),
                    icon = {},
                ) { Text(if (mode == ShadingMode.Wireframe) "Wire" else mode.label, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
        }
        Spacer(Modifier.height(4.dp))
        when (state.shading) {
            ShadingMode.Textured -> Hint("Photo texture without added lighting. Back faces are darkened; pink stripes mark repaired (synthetic) surface.")
            ShadingMode.Solid -> Hint("Neutral grey with soft lighting to judge the shape. Back faces are darkened.")
            ShadingMode.Wireframe -> Hint("Triangle edges over a dark surface.")
            ShadingMode.Evidence -> EvidenceLegend(Modifier.padding(top = 6.dp))
        }
        if (!state.hasConfidence) Hint("This model has no evidence values, so the Evidence view is unavailable.")
        Spacer(Modifier.height(8.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val holeCount = state.analysis?.holes?.size
            FilterChip(state.showHoles, { vm.setShowHoles(!state.showHoles) },
                       label = { Text(if (holeCount != null) "Open edges ($holeCount)" else "Open edges") })
            FilterChip(state.showGrid, { vm.setShowGrid(!state.showGrid) }, label = { Text("Ground grid") })
            FilterChip(state.showAxes, { vm.setShowAxes(!state.showAxes) }, label = { Text("Axes") })
            if (state.cameras.available)
                FilterChip(state.showCameras, { vm.setShowCameras(!state.showCameras) }, label = { Text("Cameras") })
        }
        if (state.showGrid && state.gridStepText != null) Hint("Grid square: ${state.gridStepText}")
        if (state.showHoles) Hint("Orange outlines are open edges of the surface: holes where no photo saw it, or the rim of the scan.")
        SectionTitle("Background", Modifier.padding(top = 0.dp))
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (b in BackgroundStyle.entries)
                FilterChip(state.background == b, { vm.setBackground(b) }, label = { Text(b.label) })
        }
        SectionTitle("View")
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilledTonalButton(onClick = { vm.fitToView() }) { Text("Fit to view") }
            OutlinedButton(onClick = { vm.standardView(StandardView.Front) }) { Text("Front") }
            OutlinedButton(onClick = { vm.standardView(StandardView.Right) }) { Text("Side") }
            OutlinedButton(onClick = { vm.standardView(StandardView.Top) }) { Text("Top") }
        }
        Spacer(Modifier.height(4.dp))
        Hint("Drag to orbit, two fingers to pan and zoom, double-tap the model to orbit around that point.")
        TextButton(onClick = onShowStats) { Text("Model info & statistics") }
    }
}

// ---- Edit ----------------------------------------------------------------------------------------

@Composable
internal fun EditPanel(state: ViewerUiState, vm: ViewerViewModel) {
    Column(Modifier.padding(vertical = 8.dp)) {
        Row(PanelPadding.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { vm.undo() }, enabled = state.undoLabel != null && state.busy == null, modifier = Modifier.weight(1f)) {
                Icon(Icons.AutoMirrored.Outlined.Undo, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp))
                Text(state.undoLabel?.let { "Undo: $it" } ?: "Nothing to undo", maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            TextButton(onClick = { vm.redo() }, enabled = state.redoLabel != null && state.busy == null, modifier = Modifier.weight(1f)) {
                Icon(Icons.AutoMirrored.Outlined.Redo, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp))
                Text(state.redoLabel?.let { "Redo: $it" } ?: "Nothing to redo", maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (t in EditTool.entries) FilterChip(state.editTool == t, { vm.setEditTool(t) }, label = { Text(t.label) })
        }
        Column(PanelPadding.padding(top = 8.dp, bottom = 8.dp)) {
            when (state.editTool) {
                EditTool.Crop -> CropTool(state, vm)
                EditTool.Trim -> TrimTool(state, vm)
                EditTool.Select -> SelectTool(state, vm)
                EditTool.Stray -> StrayTool(state, vm)
                EditTool.Orient -> OrientTool(state, vm)
                EditTool.Holes -> HolesTool(state, vm)
                EditTool.Simplify -> SimplifyTool(state, vm)
            }
            Spacer(Modifier.height(8.dp))
            Hint("Edits never change the original reconstruction. " +
                 if ((state.doc?.ops?.size ?: 0) > 0) "${state.doc?.ops?.size} edit(s) applied." else "No edits applied.")
            if ((state.doc?.ops?.size ?: 0) > 0 || (state.doc?.redo?.size ?: 0) > 0)
                TextButton(onClick = { vm.requestReset() }, enabled = state.busy == null) { Text("Reset all edits…") }
        }
    }
}

@Composable
private fun CropTool(state: ViewerUiState, vm: ViewerViewModel) {
    val crop = state.crop
    if (crop == null) { Hint("Preparing…"); return }
    if (crop.fromSuggestion) {
        InfoBanner(
            if (crop.uncertain) "Suggested crop — uncertain" else "Suggested crop",
            body = "This box is the companion's suggestion" + (if (crop.basis.isNotBlank()) " (${crop.basis})" else "") +
                ". The model deliberately includes the surroundings; adjust the box before applying." +
                if (crop.uncertain) " No support surface was found, so check it carefully." else "",
            tone = if (crop.uncertain) Tone.Warn else Tone.Provisional,
        )
    } else {
        Hint("The box starts at the bounds of the current model.")
    }
    Spacer(Modifier.height(6.dp))
    Hint("Drag a round handle to move that side, the square handle to move the box. The dimmed, dotted part will be removed.")
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Turn box", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.width(84.dp))
        Slider(crop.yawDeg, { vm.cropSetYaw(it) }, valueRange = -90f..90f, modifier = Modifier.weight(1f)
            .semantics { contentDescription = "Turn crop box about the vertical axis"; stateDescription = "${crop.yawDeg.roundToInt()} degrees" })
        Text("${crop.yawDeg.roundToInt()}°", style = NumericStyle, modifier = Modifier.width(48.dp))
    }
    val he = crop.box.halfExtents
    Hint("Box size: ${Measuring.formatModelLength(2.0 * he.x, state.effectiveScale)} × " +
         "${Measuring.formatModelLength(2.0 * he.y, state.effectiveScale)} × ${Measuring.formatModelLength(2.0 * he.z, state.effectiveScale)}")
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.horizontalScroll(rememberScrollState())) {
        Button(onClick = { vm.applyCrop() }, enabled = state.busy == null) { Text("Apply crop") }
        if (state.extras.suggestedCrop != null) OutlinedButton(onClick = { vm.cropUseSuggestion() }) { Text("Suggestion") }
        OutlinedButton(onClick = { vm.cropUseModelBounds() }) { Text("Whole model") }
    }
}

@Composable
private fun TrimTool(state: ViewerUiState, vm: ViewerViewModel) {
    val t = state.trim
    if (t == null) { Hint("Preparing…"); return }
    if (t.fromGround) InfoBanner("Suggested plane: detected support surface",
        body = "The plane starts at the surface the object stood on, as found by the reconstruction. It is a suggestion — raise or lower it before trimming.",
        tone = Tone.Provisional)
    else Hint("No support surface was detected for this model; the plane starts at its lowest point.")
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Height", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.width(84.dp))
        Slider(t.offset, { vm.trimSetOffset(it) }, valueRange = t.minOffset..t.maxOffset, modifier = Modifier.weight(1f)
            .semantics { contentDescription = "Height of the trim plane above its starting position" })
    }
    Hint("Plane offset: ${if (t.offset < 0) "−" else "+"}${Measuring.formatModelLength(kotlin.math.abs(t.offset).toDouble(), state.effectiveScale)}. " +
         "Everything below the plane (dimmed, dotted) will be removed. The cut is left open, not capped.")
    Button(onClick = { vm.applyTrim() }, enabled = state.busy == null) { Text("Trim below plane") }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SelectTool(state: ViewerUiState, vm: ViewerViewModel) {
    val sel = state.select
    ToggleRow("Draw lasso with one finger", sel.lasso, { vm.selectSetLasso(it) },
              supporting = if (sel.lasso) "Two fingers still pan and zoom. Turn off to orbit with one finger." else "Tap a piece to select everything connected to it.")
    ToggleRow("Visible surfaces only", sel.visibleOnly, { vm.selectSetVisibleOnly(it) },
              supporting = if (sel.visibleOnly) "The lasso selects only what you can see." else "The lasso selects through the model, including hidden surfaces.")
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for (c in SelectCombine.entries) FilterChip(sel.combine == c, { vm.selectSetCombine(c) }, label = { Text(c.label) })
        OutlinedButton(onClick = { vm.selectInvert() }, enabled = state.pickingReady) { Text("Invert") }
        OutlinedButton(onClick = { vm.selectClear() }, enabled = sel.selectedFaces > 0) { Text("Clear") }
    }
    Text(if (sel.selectedFaces == 0) "Nothing selected" else "${formatCount(sel.selectedFaces)} of ${formatCount(state.faceCount)} faces selected (orange, dotted)",
         style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(vertical = 6.dp))
    if (!state.pickingReady) Hint("Preparing the model for selection…")
    Button(onClick = { vm.deleteSelection() }, enabled = sel.selectedFaces > 0 && state.busy == null) {
        Icon(Icons.Outlined.Delete, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("Delete selection")
    }
}

/** Slider position 0..1 ↔ area fraction 0.01 % … 100 % on a log scale. */
internal fun strayFractionFromSlider(v: Float): Float = 10.0.pow(-4.0 + 4.0 * v.coerceIn(0f, 1f)).toFloat()
internal fun straySliderFromFraction(f: Float): Float = ((log10(f.coerceIn(1e-4f, 1f).toDouble()) + 4.0) / 4.0).toFloat()

@Composable
private fun StrayTool(state: ViewerUiState, vm: ViewerViewModel) {
    val areas = state.analysis?.componentAreas
    if (areas == null) { Hint("Counting connected pieces…"); return }
    val total = areas.size
    if (total <= 1) {
        Hint("The model is a single connected piece; there are no stray pieces to remove.")
        return
    }
    val affected = vm.strayAffected(state)
    Text("The model has $total separate pieces.", style = MaterialTheme.typography.bodyMedium)
    Row(verticalAlignment = Alignment.CenterVertically) {
        Slider(straySliderFromFraction(state.stray.minAreaFraction), { vm.straySetFraction(strayFractionFromSlider(it)) },
               modifier = Modifier.weight(1f).semantics { contentDescription = "Smallest piece to keep, as a share of the largest piece" })
        Text(formatPercent(state.stray.minAreaFraction), style = NumericStyle, modifier = Modifier.width(64.dp))
    }
    Hint("Removes pieces whose surface is smaller than ${formatPercent(state.stray.minAreaFraction)} of the largest piece: " +
         "$affected of $total piece${if (total == 1) "" else "s"} would be removed.")
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 6.dp)) {
        Button(onClick = { vm.applyRemoveStray() }, enabled = affected > 0 && state.busy == null) { Text("Remove $affected") }
        OutlinedButton(onClick = { vm.applyKeepLargest() }, enabled = state.busy == null) { Text("Keep largest piece") }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun OrientTool(state: ViewerUiState, vm: ViewerViewModel) {
    val idle = state.busy == null
    Hint("Orientation and position only — these never change the size of the model.")
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 4.dp)) {
        Button(onClick = { vm.centreOnGround() }, enabled = idle) { Text("Centre on ground") }
        FilterChip(state.orient.pickUp, { vm.orientSetPickUp(!state.orient.pickUp) }, label = { Text("Set up direction from surface") })
    }
    if (state.orient.pickUp) InfoBanner("Tap a flat part that should face up", body = "For example the table the object stood on. The model is turned so that surface is horizontal.")
    SectionTitle("Quarter turns")
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for (axis in 0..2) {
            val n = "XYZ"[axis]
            OutlinedButton(onClick = { vm.rotate90(axis, false) }, enabled = idle,
                           modifier = Modifier.semantics { contentDescription = "Rotate minus 90 degrees about $n" }) { Text("$n −90°") }
            OutlinedButton(onClick = { vm.rotate90(axis, true) }, enabled = idle,
                           modifier = Modifier.semantics { contentDescription = "Rotate plus 90 degrees about $n" }) { Text("$n +90°") }
        }
    }
    SectionTitle("Turn about vertical")
    Row(verticalAlignment = Alignment.CenterVertically) {
        Slider(state.orient.yawDeg, { vm.orientSetYaw(it) }, valueRange = -180f..180f, modifier = Modifier.weight(1f)
            .semantics { contentDescription = "Turn the model about the vertical axis"; stateDescription = "${state.orient.yawDeg.roundToInt()} degrees" })
        Text("${state.orient.yawDeg.roundToInt()}°", style = NumericStyle, modifier = Modifier.width(56.dp))
    }
    Button(onClick = { vm.applyYaw() }, enabled = idle && kotlin.math.abs(state.orient.yawDeg) >= 0.5f) { Text("Apply turn") }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun HolesTool(state: ViewerUiState, vm: ViewerViewModel) {
    val analysis = state.analysis
    if (analysis == null) { Hint("Looking for open edges…"); return }
    val entries = analysis.holes
    if (entries.isEmpty()) { Hint("The surface has no open edges; there is nothing to repair."); return }
    Hint("Holes are kept on purpose: they mark where no photo saw the surface. Repairing closes them with flat synthetic patches that are clearly marked.")
    val h = state.holes
    val byLimit = h.maxPerimeter != null
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 4.dp)) {
        FilterChip(!byLimit, { vm.holeSetMaxPerimeter(null) }, label = { Text("Choose holes") })
        FilterChip(byLimit, { vm.holeSetMaxPerimeter(h.maxPerimeter ?: HoleList.defaultMaxPerimeter(entries)) },
                   label = { Text("All smaller than…") })
    }
    val chosen: Int
    if (byLimit) {
        val maxP = entries.first().perimeter
        val minP = entries.last().perimeter
        val limit = h.maxPerimeter ?: 0f
        if (maxP > minP) Slider(limit, { vm.holeSetMaxPerimeter(it) }, valueRange = (minP * 0.99f)..(maxP * 1.01f),
                                modifier = Modifier.semantics { contentDescription = "Largest hole perimeter to repair" })
        chosen = HoleList.countUpTo(entries, limit)
        Hint("Perimeter up to ${Measuring.formatModelLength(limit.toDouble(), state.effectiveScale)}: $chosen of ${entries.size} open edges.")
    } else {
        chosen = h.selected.size
    }
    Column(Modifier.heightIn(max = 220.dp)) {
        val shown = entries.take(30)
        for ((row, e) in shown.withIndex()) {
            val isChosen = if (byLimit) e.perimeter <= (h.maxPerimeter ?: 0f) else e.index in h.selected
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                Checkbox(isChosen, onCheckedChange = if (byLimit) null else ({ _: Boolean -> vm.holeToggle(e.index) }), enabled = !byLimit,
                         modifier = Modifier.semantics { contentDescription = "Repair open edge ${row + 1}" })
                Column(Modifier.weight(1f)) {
                    Text("Open edge ${row + 1} · perimeter ${Measuring.formatModelLength(e.perimeter.toDouble(), state.effectiveScale)}",
                         style = MaterialTheme.typography.bodyMedium, maxLines = 2)
                    if (e.likelyOuterRim) Hint("Probably the outer rim of the scan, not a hole")
                }
                IconButton(onClick = { vm.holeFocus(e.index) }) { Icon(Icons.Outlined.CenterFocusStrong, "Show open edge ${row + 1}") }
            }
        }
        if (entries.size > shown.size) Hint("…and ${entries.size - shown.size} smaller ones (use \"All smaller than…\").")
    }
    Button(onClick = { vm.holesRequestFill() }, enabled = chosen > 0 && state.busy == null, modifier = Modifier.padding(top = 6.dp)) {
        Text(if (chosen == 1) "Repair 1 hole…" else "Repair $chosen holes…")
    }
}

@Composable
private fun SimplifyTool(state: ViewerUiState, vm: ViewerViewModel) {
    val sim = state.simplify
    val target = (state.faceCount * sim.fraction).roundToInt()
    Text("Target: ${formatCount(target)} of ${formatCount(state.faceCount)} faces (${(sim.fraction * 100).roundToInt()}%)",
         style = MaterialTheme.typography.bodyMedium)
    Slider(sim.fraction, { vm.simplifySetFraction(it, false) }, onValueChangeFinished = { vm.simplifySetFraction(vm.state.value.simplify.fraction, true) },
           valueRange = 0.05f..1f, modifier = Modifier.semantics { contentDescription = "Share of faces to keep" })
    when {
        sim.computing -> Row(verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp); Spacer(Modifier.width(10.dp))
            Hint("Computing preview and measuring the difference…")
        }
        sim.error != null -> InfoBanner("Preview failed", body = sim.error, tone = Tone.Bad)
        sim.preview != null -> {
            val p = sim.preview
            LabeledValue("Faces", "${formatCount(p.originalFaces)} → ${formatCount(p.resultFaces)}")
            LabeledValue("Mean deviation", p.meanText)
            LabeledValue("95% of surface within", p.p95Text)
            LabeledValue("Relative to model size", "${formatPercent(p.deviation.meanRelativeToDiagonal)} mean · ${formatPercent(p.deviation.p95RelativeToDiagonal)} at 95%")
            Hint("Measured between the current and the simplified surface (${formatCount(p.deviation.sampleCount)} sample points). The preview is shown in the viewport.")
            if (!p.targetReached) Hint("Texture seams and open edges stopped the reduction before the target was reached.")
        }
        sim.fraction >= 0.999f -> Hint("Move the slider to preview a lighter model.")
        else -> Hint("Release the slider to compute a preview.")
    }
    Button(onClick = { vm.applySimplify() }, enabled = sim.preview != null && !sim.computing && state.busy == null,
           modifier = Modifier.padding(top = 6.dp)) { Text("Apply simplification") }
}

// ---- Measure -------------------------------------------------------------------------------------

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun MeasurePanel(state: ViewerUiState, vm: ViewerViewModel) {
    Column(PanelPadding.padding(vertical = 12.dp)) {
        val cal = state.measure.calibration
        if (cal != null) {
            val step = when {
                cal.a == null -> "Tap the first end of a distance you know (for example one end of a ruler)."
                cal.b == null -> "Now tap the other end."
                else -> "Both ends are placed. Drag them to adjust, then enter the real distance."
            }
            InfoBanner("Calibrate scale", body = "$step Press and hold for the magnifier.", tone = Tone.Companion)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
                Button(onClick = { vm.openCalibrationDialog() }, enabled = cal.a != null && cal.b != null) { Text("Enter distance…") }
                OutlinedButton(onClick = { vm.cancelCalibration() }) { Text("Cancel") }
            }
            return@Column
        }
        Text(state.scaleStatus.detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 6.dp)) {
            FilledTonalButton(onClick = { vm.startCalibration() }, enabled = state.pickingReady) {
                Text(if (state.doc?.scale != null) "Recalibrate…" else "Calibrate scale…")
            }
            if (state.doc?.scale != null) OutlinedButton(onClick = { vm.clearCalibration() }) { Text("Clear calibration") }
        }
        HorizontalDivider(Modifier.padding(vertical = 10.dp))
        if (state.measure.pending != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("First point placed — tap the second point.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                TextButton(onClick = { vm.cancelPendingPoint() }) { Text("Cancel") }
            }
        } else {
            Hint(if (state.pickingReady) "Tap two points on the model to measure between them. Press and hold for the magnifier; drag an end point to adjust it."
                 else "Preparing the model for measuring…")
        }
        if (state.measure.rows.isEmpty()) {
            Hint("No measurements yet.", Modifier.padding(top = 8.dp))
        }
        for (r in state.measure.rows) {
            Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).semantics(mergeDescendants = true) {}) {
                    Text(r.measurement.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(r.label, style = NumericStyle)
                    if (r.offSurface) Text("Endpoint no longer on surface — the surface it was measured on has been removed by an edit.",
                                           style = MaterialTheme.typography.bodySmall, color = dev.pocket3d.design.P3.colors.warn)
                }
                IconButton(onClick = { vm.setRenaming(r.measurement.id) }) { Icon(Icons.Outlined.Edit, "Rename ${r.measurement.name}") }
                IconButton(onClick = { vm.deleteMeasurement(r.measurement.id) }) { Icon(Icons.Outlined.Delete, "Delete ${r.measurement.name}") }
            }
        }
    }
}

// ---- Cameras -------------------------------------------------------------------------------------

@Composable
internal fun CamerasPanel(state: ViewerUiState, vm: ViewerViewModel, camera: OrbitCamera) {
    val c = state.cameras
    Column(PanelPadding.padding(vertical = 12.dp)) {
        if (!c.available) {
            InfoBanner("No camera data", body = "This model was delivered without camera positions (cameras.json).")
            return@Column
        }
        if (c.lookingFromId != null && vm.isLookingFrom(camera)) {
            val name = c.placed.firstOrNull { it.source.id == c.lookingFromId }?.source?.name ?: c.lookingFromId
            InfoBanner("Viewing from photo $name", body = "The view matches where this photo was taken from. Fade the photo in to compare it with the model.", tone = Tone.Companion)
            if (c.photo?.filePath != null) Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Photo", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.width(64.dp))
                Slider(c.overlayAlpha, { vm.setOverlayAlpha(it) }, modifier = Modifier.weight(1f)
                    .semantics { contentDescription = "Opacity of the photo over the model" })
            }
            OutlinedButton(onClick = { vm.stopLookingFrom() }) { Text("Back to free view") }
            HorizontalDivider(Modifier.padding(vertical = 10.dp))
        }
        ToggleRow("Show camera positions", state.showCameras, { vm.setShowCameras(it) },
                  supporting = "Each pyramid is one registered photo. Tap one to see it.")
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f)) {
                StatusPill("REGISTERED VIEWPOINTS", Tone.Provisional)
                Spacer(Modifier.height(6.dp))
                c.coverage?.let { g ->
                    CoverageGridView(g)
                    Hint(ViewpointCoverage.summary(g), Modifier.padding(top = 4.dp))
                }
                Hint("Where the registered photos were taken from (around the object × low/mid/high), counted in 30° " +
                     "sectors — the job screen states the exact largest angle between neighbouring photos. It does not " +
                     "show what was reconstructed.")
            }
            Column(Modifier.weight(1f)) {
                StatusPill("VERIFIED SURFACE SUPPORT", Tone.Good)
                Spacer(Modifier.height(6.dp))
                val e = state.analysis?.evidence
                if (e == null) Hint("Analysing…")
                else if (!e.hasConfidence) Hint("This model carries no evidence values.")
                else {
                    EvidenceBar(e)
                    Hint("${formatPercent(e.wellSupported)} well supported · ${formatPercent(e.weak)} weak · ${formatPercent(e.none)} none" +
                         if (e.repaired > 0f) " · ${formatPercent(e.repaired)} repaired" else "", Modifier.padding(top = 4.dp))
                }
                Hint("Share of the surface of the model as it is now (whole delivered mesh incl. surroundings, after " +
                     "your edits) that photos back up. The job screen's figure covers only the suggested object box.")
            }
        }
        SectionTitle("Registered photos (${c.placed.size})")
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (p in c.placed.take(300)) {
                FilterChip(c.selectedId == p.source.id, { vm.selectCamera(p.source.id) },
                           label = { Text(p.source.name.ifBlank { c.frameNames[p.source.id] ?: p.source.id }, maxLines = 1) })
            }
        }
        val missing = c.unregistered + c.rejected
        SectionTitle("Not used (${missing.size})")
        if (missing.isEmpty()) Hint("Every submitted photo was registered.")
        else {
            Hint("These photos are not part of the model. Retaking them with more overlap to their neighbours usually helps.")
            for (u in missing.take(60)) {
                val reason = if (u in c.rejected && u.reason.isNotBlank()) FrameFlag.describe(u.reason) else CamerasJson.describeReason(u.reason)
                LabeledValue(c.frameNames[u.id] ?: "Photo ${u.id}", reason, tone = Tone.Warn)
            }
            if (missing.size > 60) Hint("…and ${missing.size - 60} more.")
        }
    }
}

// ---- Export --------------------------------------------------------------------------------------

@Composable
internal fun ExportPanel(state: ViewerUiState, vm: ViewerViewModel, onSaveTo: (ExportFormat) -> Unit) {
    val ex = state.export
    val running = ex.stage != null
    Column(PanelPadding.padding(vertical = 12.dp)) {
        Hint("Exports the model as it is now, with your edits (${formatCount(state.faceCount)} faces). The original reconstruction stays untouched.")
        for (f in ExportFormat.entries) {
            Row(Modifier.fillMaxWidth().heightIn(min = 56.dp)
                    .selectable(ex.format == f, enabled = !running, role = Role.RadioButton, onClick = { vm.setExportFormat(f) }),
                verticalAlignment = Alignment.CenterVertically) {
                RadioButton(ex.format == f, onClick = null, enabled = !running)
                Spacer(Modifier.width(10.dp))
                Column {
                    Text(f.label + if (f == ExportFormat.GLB) " — recommended" else "", style = MaterialTheme.typography.bodyMedium)
                    Hint(f.description)
                }
            }
        }
        Spacer(Modifier.height(6.dp))
        val scale = state.effectiveScale
        InfoBanner(if (scale == null) "No real-world scale" else "Units: metres",
                   body = ExportBuilder.unitsStatement(scale) + (if (scale != null) " ${state.scaleStatus.text}." else ""),
                   tone = if (scale == null) Tone.Warn else Tone.Good)
        val repaired = state.analysis?.evidence?.repaired ?: 0f
        if (repaired > 0f) Hint("${formatPercent(repaired)} of the surface is synthetic hole repair; it stays marked as repaired in the export.",
                                Modifier.padding(top = 6.dp))
        Spacer(Modifier.height(10.dp))
        if (running) {
            LinearProgressIndicator(Modifier.fillMaxWidth())
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("${ex.stage}…", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                TextButton(onClick = { vm.cancelExport() }) { Text("Cancel") }
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { onSaveTo(ex.format) }, enabled = state.ready && state.busy == null) {
                    Icon(Icons.Outlined.SaveAlt, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("Save to…")
                }
                FilledTonalButton(onClick = { vm.exportShare() }, enabled = state.ready && state.busy == null) {
                    Icon(Icons.Outlined.IosShare, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("Share")
                }
            }
        }
        when (val o = ex.outcome) {
            is ExportOutcome.Success -> InfoBanner(
                if (o.shared) "Ready to share: ${o.fileName}" else "Saved ${o.fileName}",
                body = "Read back and checked: ${o.summary}. ${o.unitsStatement}", tone = Tone.Good, modifier = Modifier.padding(top = 10.dp))
            is ExportOutcome.Failure -> InfoBanner("Export failed", body = o.message, tone = Tone.Bad, modifier = Modifier.padding(top = 10.dp))
            null -> {}
        }
    }
}
