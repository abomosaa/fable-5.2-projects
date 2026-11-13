package dev.pocket3d.viewer.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import dev.pocket3d.design.InfoBanner
import dev.pocket3d.design.LabeledValue
import dev.pocket3d.design.SectionTitle
import dev.pocket3d.design.StatusPill
import dev.pocket3d.design.Tone
import dev.pocket3d.viewer.CalibrationUi
import dev.pocket3d.viewer.MeasurementRow
import dev.pocket3d.viewer.ViewerUiState
import dev.pocket3d.viewer.ViewerViewModel
import dev.pocket3d.viewer.measure.LengthInput
import dev.pocket3d.viewer.measure.LengthUnit
import dev.pocket3d.viewer.measure.Measuring
import dev.pocket3d.viewer.measure.formatPercentUncertainty
import dev.pocket3d.viewer.scene.PlacedCamera
import java.text.DateFormat
import java.util.Date

/** Inspection sheet: geometry numbers, evidence, textures, scale, provenance and reconstruction warnings. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun StatsSheet(state: ViewerUiState, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).navigationBarsPadding().padding(bottom = 24.dp)) {
            Text("Model info", style = MaterialTheme.typography.titleLarge)
            val scale = state.effectiveScale
            fun len(v: Float) = Measuring.formatModelLength(v.toDouble(), scale)

            SectionTitle("Scale")
            StatusPill(state.scaleStatus.text, state.scaleStatus.tone)
            Hint(state.scaleStatus.detail, Modifier.padding(top = 6.dp))
            state.doc?.scale?.let { c ->
                val d = c.refDistanceMeters
                if (d != null) LabeledValue("Reference distance", dev.pocket3d.core.scale.Length(d, c.refToleranceMeters ?: 0.0, true).format())
                LabeledValue("Scale uncertainty", formatPercentUncertainty(c.relativeUncertainty))
            }
            state.model?.reconstructionScale?.note?.takeIf { it.isNotBlank() }?.let { Hint("Reconstruction: $it", Modifier.padding(top = 4.dp)) }

            SectionTitle("Geometry (current, with edits)")
            LabeledValue("Faces", formatCount(state.faceCount))
            LabeledValue("Vertices", formatCount(state.vertexCount))
            val a = state.analysis
            if (a == null) {
                Hint("Analysing the surface…")
            } else {
                val st = a.stats
                val size = st.bounds.size
                LabeledValue("Size (X × Y × Z)", "")
                Hint("${len(size.x)} × ${len(size.y)} × ${len(size.z)}")
                LabeledValue("Surface area", Measuring.formatArea(st.surfaceArea.toDouble(), scale))
                LabeledValue("Separate pieces", formatCount(st.componentCount))
                LabeledValue("Open edges (holes and rims)", formatCount(st.holeCount), tone = if (st.holeCount > 0) Tone.Warn else Tone.Neutral)
                LabeledValue("Total open-edge length", len(a.boundaryLength))
                LabeledValue("Typical triangle edge", len(st.medianEdgeLength))
                if (st.nonManifoldEdgeCount > 0) LabeledValue("Non-manifold edges", formatCount(st.nonManifoldEdgeCount), tone = Tone.Warn)
                Hint("Open edges are kept on purpose: they show where no photo saw the surface.")

                SectionTitle("Verified surface support")
                val e = a.evidence
                if (!e.hasConfidence) {
                    Hint("This model carries no per-vertex evidence values.")
                } else {
                    EvidenceBar(e, Modifier.padding(bottom = 6.dp))
                    LabeledValue("Well supported by photos", formatPercent(e.wellSupported), tone = Tone.Good)
                    LabeledValue("Weakly supported", formatPercent(e.weak), tone = if (e.weak > 0.05f) Tone.Warn else Tone.Neutral)
                    LabeledValue("No photographic evidence", formatPercent(e.none), tone = if (e.none > 0.01f) Tone.Warn else Tone.Neutral)
                    st.lowConfidenceAreaFraction?.let { LabeledValue("Low-confidence area (below ${st.lowConfidenceThreshold})", formatPercent(it)) }
                }
                LabeledValue("Repaired (synthetic) area", formatPercent(st.repairedAreaFraction),
                             tone = if (st.repairedAreaFraction > 0f) Tone.Warn else Tone.Neutral)
                Hint("Share of the surface area. Use the Evidence view to see where.")
            }

            SectionTitle("Textures")
            val tex = state.textures
            if (!state.hasTextures) Hint("This model has no texture.")
            else if (tex == null || (tex.pages.isEmpty() && tex.loading)) Hint("Decoding textures…")
            else {
                for ((i, p) in tex.pages.withIndex()) {
                    val v = when {
                        p.error != null -> "not shown"
                        p.reduced -> "${p.originalWidth}×${p.originalHeight} → shown ${p.shownWidth}×${p.shownHeight}"
                        else -> "${p.originalWidth}×${p.originalHeight}"
                    }
                    LabeledValue("Page ${i + 1} (${p.mimeType.substringAfter('/')}, ${formatCount(p.encodedBytes / 1024)} kB)", v,
                                 tone = if (p.error != null) Tone.Bad else if (p.reduced) Tone.Warn else Tone.Neutral)
                    p.error?.let { Hint(it) }
                }
                if (tex.anyReduced) InfoBanner("Texture shown at reduced resolution; export keeps the original",
                    body = "The phone's graphics memory limits how large a texture can be displayed.", tone = Tone.Warn, modifier = Modifier.padding(top = 6.dp))
                if (tex.loading) Hint("Still decoding…")
            }

            SectionTitle("Reconstruction")
            val m = state.model
            LabeledValue("Preset", state.extras.preset ?: m?.preset?.ifBlank { null } ?: "unknown")
            LabeledValue("Settings fingerprint", state.extras.settingsFingerprint ?: m?.settingsFingerprint?.ifBlank { null } ?: "unknown")
            if (m != null) {
                if (m.createdAtMs > 0) LabeledValue("Created", DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(m.createdAtMs)))
                if (m.inputFrames > 0) LabeledValue("Photos registered", "${m.registeredCameras} of ${m.inputFrames}",
                                                    tone = if (m.registeredCameras < m.inputFrames) Tone.Warn else Tone.Neutral)
            }
            state.diagnostics?.meanReprojectionErrorPx?.let { LabeledValue("Mean reprojection error", "%.2f px".format(it)) }
            state.extras.originNote?.let { Hint("Origin: $it") }
            LabeledValue("Edits applied", formatCount(state.doc?.ops?.size ?: 0))

            val warnings = state.diagnostics?.warnings.orEmpty()
            SectionTitle("Reconstruction warnings (${warnings.size})")
            if (state.diagnostics == null) Hint("No diagnostics file was delivered with this model.")
            else if (warnings.isEmpty()) Hint("The reconstruction reported no warnings.")
            for (w in warnings) {
                InfoBanner(w.message, tone = Tone.Warn, body = w.code.takeIf { it.isNotBlank() }?.let { "Code: $it" }, modifier = Modifier.padding(bottom = 8.dp))
            }
            val limitations = state.diagnostics?.limitations.orEmpty()
            if (limitations.isNotEmpty()) {
                SectionTitle("Known limitations")
                for (l in limitations) Hint("• $l", Modifier.padding(bottom = 4.dp))
            }
            if (state.loadNotes.isNotEmpty()) {
                SectionTitle("Notes from opening this model")
                for (n in state.loadNotes) Hint("• $n", Modifier.padding(bottom = 4.dp))
            }
        }
    }
}

/** Details of one registered photo. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CameraSheet(state: ViewerUiState, camera: PlacedCamera, onLookFrom: () -> Unit, onOpenPhoto: (() -> Unit)?, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).navigationBarsPadding().padding(bottom = 24.dp)) {
            val name = camera.source.name.ifBlank { state.cameras.frameNames[camera.source.id] ?: "Photo ${camera.source.id}" }
            Text(name, style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.height(10.dp))
            val photo = state.cameras.photo
            FramePhoto(photo?.filePath, photo?.exifOrientation ?: 1, "Photo $name", Modifier.fillMaxWidth().heightIn(min = 120.dp, max = 320.dp))
            Spacer(Modifier.height(8.dp))
            LabeledValue("Sparse tie points seen", formatCount(camera.source.sparsePoints),
                         tone = if (camera.source.sparsePoints < 100) Tone.Warn else Tone.Neutral)
            if (camera.source.width > 0) LabeledValue("Working image", "${camera.source.width} × ${camera.source.height}")
            LabeledValue("Vertical field of view", "%.1f°".format(camera.source.fovYDeg))
            Hint("Tie points are features this photo shares with others; few of them mean the photo is only weakly connected to the rest.")
            Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onLookFrom) { Text("Look from this camera") }
                if (onOpenPhoto != null) OutlinedButton(onClick = onOpenPhoto) { Text("Open photo") }
            }
        }
    }
}

/** Distance, unit and tolerance of the reference the user marked. */
@Composable
internal fun CalibrationDialog(state: ViewerUiState, cal: CalibrationUi, vm: ViewerViewModel) {
    var distance by rememberSaveable { mutableStateOf("") }
    var tolerance by rememberSaveable { mutableStateOf("") }
    var unitName by rememberSaveable { mutableStateOf(LengthUnit.CM.name) }
    val unit = LengthUnit.valueOf(unitName)
    val a = cal.a; val b = cal.b
    AlertDialog(
        onDismissRequest = { vm.closeCalibrationDialog() },
        title = { Text("Real distance between A and B") },
        text = {
            Column {
                if (a != null && b != null) {
                    Hint("On the model the two points are ${Measuring.formatModelLength(a.point.distanceTo(b.point).toDouble(), null)} apart.")
                    Spacer(Modifier.height(8.dp))
                }
                OutlinedTextField(distance, { distance = it }, label = { Text("Distance (${unit.symbol})") }, singleLine = true,
                                  isError = cal.error != null && LengthInput.parseMeters(distance, unit) == null,
                                  keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
                Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (u in LengthUnit.entries) FilterChip(unit == u, { unitName = u.name }, label = { Text(u.symbol) })
                }
                OutlinedTextField(tolerance, { tolerance = it },
                                  label = { Text("How exactly you know it, ± ${unit.symbol} (optional)") },
                                  placeholder = { Text(LengthInput.defaultToleranceText(unit)) }, singleLine = true,
                                  keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                                  modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                Hint("Leave empty for ±1 mm. The scale's uncertainty combines this with how precisely the two points could be picked.", Modifier.padding(top = 4.dp))
                cal.error?.let { InfoBanner("Cannot calibrate", body = it, tone = Tone.Bad, modifier = Modifier.padding(top = 10.dp)) }
            }
        },
        confirmButton = { Button(onClick = { vm.submitCalibration(distance, unit, tolerance) }) { Text("Calibrate") } },
        dismissButton = { TextButton(onClick = { vm.closeCalibrationDialog() }) { Text("Adjust points") } },
    )
}

@Composable
internal fun RenameMeasurementDialog(row: MeasurementRow, onRename: (String) -> Unit, onDismiss: () -> Unit) {
    var name by rememberSaveable(row.measurement.id) { mutableStateOf(row.measurement.name) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Rename measurement") },
        text = { OutlinedTextField(name, { name = it.take(60) }, singleLine = true, label = { Text("Name") }) },
        confirmButton = { Button(onClick = { onRename(name) }, enabled = name.isNotBlank()) { Text("Rename") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
internal fun ConfirmDialog(title: String, body: String, confirmLabel: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(body) },
        confirmButton = { Button(onClick = onConfirm) { Text(confirmLabel) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
