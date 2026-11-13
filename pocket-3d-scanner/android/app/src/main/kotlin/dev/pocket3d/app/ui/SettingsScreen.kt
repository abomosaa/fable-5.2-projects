package dev.pocket3d.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pocket3d.app.BuildConfig
import dev.pocket3d.capture.CapabilityProbe
import dev.pocket3d.capture.matrixRows
import dev.pocket3d.core.services.Services
import dev.pocket3d.design.Dot
import dev.pocket3d.design.SectionTitle
import dev.pocket3d.design.StatusPill
import dev.pocket3d.design.Tone

/** Where each part of the workflow actually runs. Shown verbatim; mirrors docs/ARCHITECTURE.md. */
private val WHERE: List<Triple<String, String, Boolean>> = listOf(
    Triple("Camera capture, focus/exposure lock", "Phone", true),
    Triple("Blur / exposure / duplicate checks", "Phone", true),
    Triple("Viewpoint coverage (tracked or estimated)", "Phone", true),
    Triple("Photo import, review, exclusion", "Phone", true),
    Triple("Feature extraction and matching (SIFT)", "Companion", false),
    Triple("Camera poses, bundle adjustment (COLMAP)", "Companion", false),
    Triple("Dense depth maps, fusion (OpenMVS)", "Companion", false),
    Triple("Surface meshing and texturing (OpenMVS)", "Companion", false),
    Triple("Provisional sparse preview (computed)", "Companion", false),
    Triple("3D viewing, evidence overlay, hole inspection", "Phone", true),
    Triple("Crop, delete, reorient, simplify, hole repair", "Phone", true),
    Triple("Scale calibration and measurement", "Phone", true),
    Triple("GLB / OBJ / PLY export, sharing", "Phone", true),
    Triple("AR placement (ARCore devices)", "Phone", true),
)

private val LIMITATIONS = listOf(
    "Shiny, mirror-like or transparent objects reconstruct poorly or not at all: their appearance changes with the viewpoint.",
    "Plain, texture-less surfaces give few matching points; expect holes or noise there.",
    "Very thin parts (wires, leaves, hair) are usually lost.",
    "The object must not move during capture. Turntable shots against a visible static background are not supported.",
    "Surfaces no photo saw (underside, deep cavities) stay open holes unless you explicitly repair them — repaired areas are marked as synthetic.",
    "Photos alone give shape but not size. Real measurements need a scale calibration (known distance) or validated AR tracking.",
    "Reprojection error and coverage rings are diagnostics, not proof of geometric accuracy.",
)

private val LICENSES = listOf(
    "COLMAP / pycolmap (companion) — BSD-3-Clause",
    "OpenMVS 2.3.0 (companion) — AGPL-3.0; VCGlib — GPL-3.0",
    "Open3D (companion) — MIT · NumPy/SciPy — BSD · Pillow — MIT-CMU · aiohttp — Apache-2.0",
    "AndroidX, Jetpack Compose, CameraX, OkHttp, kotlinx.serialization/coroutines — Apache-2.0",
    "Google ARCore SDK — Apache-2.0 (Google Play Services for AR: Google terms)",
    "ZXing core — Apache-2.0",
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(onBack: () -> Unit, onOpenPairing: () -> Unit) {
    val context = LocalContext.current
    val companion by Services.companion.state.collectAsStateWithLifecycle()
    val caps by produceState<List<Triple<String, String, Tone>>?>(null) { value = runCatching { CapabilityProbe.probe(context).matrixRows() }.getOrElse {
        listOf(Triple("Capability detection", "failed: ${it.message}", Tone.Bad)) } }
    Scaffold(topBar = {
        TopAppBar(title = { Text("About & capabilities") },
                  navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") } })
    }) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            SectionTitle("Companion")
            val (text, tone) = companionSummary(companion)
            Row(Modifier.fillMaxWidth().clickable(onClick = onOpenPairing).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween) {
                StatusPill(text, tone)
                Text("Manage", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
            }

            SectionTitle("What runs where")
            WHERE.forEach { (what, where, phone) ->
                Row(Modifier.fillMaxWidth().padding(vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(what, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                    Spacer(Modifier.width(8.dp))
                    StatusPill(where, if (phone) Tone.Good else Tone.Companion)
                }
            }
            Text("Nothing is reconstructed in the cloud, and the phone does not pretend to do the companion’s work.",
                 style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)

            SectionTitle("This device")
            val rows = caps
            if (rows == null) LinearProgressIndicator(Modifier.fillMaxWidth()) else rows.forEach { (feature, status, t) ->
                Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.Top) {
                    Dot(t, Modifier.padding(top = 6.dp))
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(feature, style = MaterialTheme.typography.bodyMedium)
                        Text(status, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            Text("Detected from the platform on this device. Features the hardware lacks are reported as unavailable, never simulated.",
                 style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)

            SectionTitle("Limits of photogrammetry")
            LIMITATIONS.forEach { Text("• $it", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(vertical = 3.dp)) }

            SectionTitle("Open-source components")
            LICENSES.forEach { Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(vertical = 2.dp)) }
            Spacer(Modifier.height(8.dp))
            HorizontalDivider()
            Text("Pocket 3D Scanner ${BuildConfig.VERSION_NAME} (${BuildConfig.BUILD_TYPE}) · full licence manifest: docs/LICENSES.md",
                 style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 12.dp))
            Spacer(Modifier.height(24.dp))
        }
    }
}
