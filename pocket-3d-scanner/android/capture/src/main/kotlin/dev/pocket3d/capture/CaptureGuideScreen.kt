package dev.pocket3d.capture

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.outlined.Cancel
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material.icons.outlined.ViewInAr
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.pocket3d.design.InfoBanner
import dev.pocket3d.design.P3
import dev.pocket3d.design.Pocket3DTheme
import dev.pocket3d.design.SectionTitle
import dev.pocket3d.design.StatusPill
import dev.pocket3d.design.Tone
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Explains the capture strategy this app actually relies on (a rigid scene photographed from a
 * moving camera), with diagrams drawn on Canvas, and states plainly what cannot be reconstructed.
 * Wording is deliberately concrete: nothing here promises a result the pipeline cannot deliver.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CaptureGuideScreen(onStartCapture: () -> Unit, onImport: () -> Unit, onBack: () -> Unit) {
    val scrollBehavior = TopAppBarDefaults.pinnedScrollBehavior()
    Scaffold(
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            TopAppBar(
                title = { Text("How to capture") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                scrollBehavior = scrollBehavior,
            )
        },
        bottomBar = { GuideBottomBar(onStartCapture = onStartCapture, onImport = onImport) },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.TopCenter) {
            Column(
                Modifier
                    .widthIn(max = 640.dp)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp),
            ) {
                GuideIntro()
                GuideOrbitSection()
                GuideRingsSection()
                GuideFramingSection()
                GuideLightingSection()
                GuideBackgroundSection()
                GuideInvalidMotionSection()
                GuideLimitationsSection()
                GuideAfterCaptureSection()
                Spacer(Modifier.height(24.dp))
            }
        }
    }
}

// ------------------------------------------------------------------------------------------------
// Sections
// ------------------------------------------------------------------------------------------------

@Composable
private fun GuideIntro() {
    Spacer(Modifier.height(8.dp))
    Text(
        "The object stays still. You move around it.",
        style = MaterialTheme.typography.headlineSmall,
        color = MaterialTheme.colorScheme.onSurface,
        modifier = Modifier.semantics { heading() },
    )
    Spacer(Modifier.height(8.dp))
    GuideBody(
        "Photogrammetry finds the same surface details in many overlapping photos taken from " +
            "different positions and triangulates them into a 3D model. That only works when the " +
            "scene is rigid while the camera moves — and when the surface has visible detail to match.",
    )
    Spacer(Modifier.height(14.dp))
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = MaterialTheme.shapes.medium,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp)) {
            GuideCheckRow("Stationary object with visible texture")
            GuideCheckRow("Walk around it: a photo about every 12° (≈ 30 per ring)")
            GuideCheckRow("2–3 rings at different heights: low, mid, high")
            GuideCheckRow("Whole object in frame, filling about 60–80 %")
            GuideCheckRow("Stable, diffuse light and a background that stays put")
        }
    }
}

@Composable
private fun GuideOrbitSection() {
    SectionTitle("1 · Walk around the object")
    GuideDiagramCard(
        description = "Diagram, seen from above: a textured object in the centre. Thirty camera positions " +
            "form a full circle around it, one every 12 degrees, all aimed at the object. The fields of " +
            "view of three neighbouring positions overlap heavily. An arrow shows walking around the circle.",
        height = 232.dp,
    ) { p, m, style -> guideDrawOrbit(p, m, style) }
    Spacer(Modifier.height(10.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        StatusPill("≈ 12° between photos")
        StatusPill("≈ 30 photos per ring")
    }
    Spacer(Modifier.height(8.dp))
    GuideBody(
        "Put the object where you can get all the way around it. Keep it centred and take a photo " +
            "roughly every 12° — about 30 photos for one full ring. Neighbouring photos should show " +
            "mostly the same surface (around 70–80 % overlap). Photos more than about 30° apart often " +
            "cannot be matched to each other, which leaves gaps or breaks the model into pieces.",
    )
}

@Composable
private fun GuideRingsSection() {
    SectionTitle("2 · Two or three rings at different heights")
    GuideDiagramCard(
        description = "Diagram, seen from the side: the object stands on a surface. Cameras circle it on " +
            "three rings: a low ring about level with the object, a mid ring looking down at roughly " +
            "35 degrees, and a high ring looking down at roughly 60 degrees. Every camera is aimed at the object.",
        height = 240.dp,
    ) { p, m, style -> guideDrawRings(p, m, style) }
    Spacer(Modifier.height(10.dp))
    GuideBody(
        "A single ring from one height never sees the top and misses undercuts. Walk a low ring " +
            "(about level with the object), then a mid ring (looking down at roughly 35°). Add a " +
            "high ring (roughly 60°) when the top surface matters. Two to three rings are about " +
            "60–90 photos. The underside the object rests on is never seen and will not be reconstructed.",
    )
}

@Composable
private fun GuideFramingSection() {
    SectionTitle("3 · Keep the whole object in frame")
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        GuideVerdictPanel(
            ok = false, label = "Too small",
            description = "Does not work well: the object is tiny in the frame, so little detail is recorded.",
            aspect = 3f / 4f, modifier = Modifier.weight(1f),
        ) { p -> guideDrawFraming(GuideFraming.TooSmall, p) }
        GuideVerdictPanel(
            ok = true, label = "60–80 %",
            description = "Works: the whole object is visible, centred, and fills about 60 to 80 percent of the frame.",
            aspect = 3f / 4f, modifier = Modifier.weight(1f),
        ) { p -> guideDrawFraming(GuideFraming.Good, p) }
        GuideVerdictPanel(
            ok = false, label = "Cut off",
            description = "Does not work well: the object is cut off by the edge of the frame.",
            aspect = 3f / 4f, modifier = Modifier.weight(1f),
        ) { p -> guideDrawFraming(GuideFraming.Cropped, p) }
    }
    Spacer(Modifier.height(10.dp))
    GuideBody(
        "Aim the centre of the frame at the object and keep roughly the same distance all the way " +
            "round, so it fills about 60–80 % of the picture. Some surroundings in the frame are " +
            "useful: they help work out where each photo was taken from. For large objects that do " +
            "not fit, keep the steps small so neighbouring photos still overlap.",
    )
}

@Composable
private fun GuideLightingSection() {
    SectionTitle("4 · Stable, diffuse light")
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        GuideVerdictPanel(
            ok = true, label = "Soft, even light",
            description = "Works: a large soft light source lights the object evenly, with only a faint shadow.",
            aspect = 4f / 3f, modifier = Modifier.weight(1f),
        ) { p -> guideDrawLighting(soft = true, p = p) }
        GuideVerdictPanel(
            ok = false, label = "Hard or changing light",
            description = "Does not work well: a single small bright light leaves one side of the object dark, " +
                "casts a hard shadow and creates a glare spot.",
            aspect = 4f / 3f, modifier = Modifier.weight(1f),
        ) { p -> guideDrawLighting(soft = false, p = p) }
    }
    Spacer(Modifier.height(10.dp))
    GuideBody(
        "Overcast daylight or several soft lamps are ideal. Avoid hard direct sun, lights that move " +
            "or flicker, the phone's flash, and your own shadow crossing the object: shading that " +
            "changes between photos looks like a different surface. More light also gives sharper, " +
            "less noisy photos. Lock focus and exposure once the object is framed, if your phone allows it.",
    )
}

@Composable
private fun GuideBackgroundSection() {
    SectionTitle("5 · A background that stays put")
    GuideBody(
        "The surroundings are part of the same rigid scene and are used to locate the camera. Do " +
            "not move the object, what it stands on, or things next to it while capturing. Someone " +
            "passing in the distance is usually tolerated; a busy, moving background is not. If the " +
            "object gets bumped, start that capture again.",
    )
}

@Composable
private fun GuideInvalidMotionSection() {
    val bad = P3.colors.bad
    SectionTitle("What does not work")
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Outlined.Cancel, contentDescription = null, tint = bad, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(8.dp))
        Text(
            "Turning the object instead of moving the phone",
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
    Spacer(Modifier.height(10.dp))
    GuideDiagramCard(
        description = "Diagram of a setup that does not work: the phone stays fixed in one place while the " +
            "object turns on a turntable. Behind the object a background with visible detail stays still. " +
            "The photos therefore contain two contradictory motions.",
        height = 208.dp,
    ) { p, m, style -> guideDrawTurntable(p, m, style) }
    Spacer(Modifier.height(10.dp))
    GuideBody(
        "Rotating the object in your hands or on a turntable, in front of a background that is " +
            "visible and stays still, mixes two motions in the same photos: the background says the " +
            "camera never moved, the object says it circled all the way round. Reconstruction " +
            "assumes one rigid scene, so this is invalid input — typically the software locks onto " +
            "the background and the object comes out smeared, doubled or missing.",
    )
    Spacer(Modifier.height(10.dp))
    InfoBanner(
        title = "This app does not remove backgrounds",
        body = "Turntable capture needs a background with no visible detail at all, or masking of every " +
            "photo. Neither is checked or done here, so walk around a stationary object instead.",
        tone = Tone.Warn,
    )
    Spacer(Modifier.height(10.dp))
    GuideCrossRow("Standing in one spot and only turning the phone (a panorama): no change of position, so no depth can be triangulated.")
    GuideCrossRow("Picking the object up or flipping it over part-way through a capture.")
    GuideCrossRow("A handful of photos from far-apart directions with little overlap.")
}

private data class GuideLimitationItem(val title: String, val why: String, val helps: String)

private val GuideLimitationItems = listOf(
    GuideLimitationItem(
        "Shiny or reflective",
        "Polished metal, glazed ceramics, glossy plastic. Reflections and highlights slide across the surface as you move, so they are not fixed details.",
        "Diffuse light with no direct lamps; more overlap. Matte scanning spray or powder where that is acceptable for the object. Mirror-like surfaces usually still fail.",
    ),
    GuideLimitationItem(
        "Transparent or translucent",
        "Glass, clear plastic, liquids. The camera sees what is behind or inside, not the surface.",
        "Matte spray or powder where acceptable. Without a coating, expect holes or no usable surface.",
    ),
    GuideLimitationItem(
        "Plain, textureless surfaces",
        "Uniform smooth plastic, blank paper, plain painted walls. There is nothing to match between photos.",
        "Stand the object on textured cloth or newspaper so the photos can still be aligned, add more light and more overlap. Removable speckle (powder, bits of tape) where acceptable. Blank areas may still come out with holes or noise.",
    ),
    GuideLimitationItem(
        "Moving or deforming",
        "People, pets, plants in a breeze, soft items that sag or shift between photos.",
        "Support it firmly, shelter it from wind and capture without pauses. If it moved, capture again — photos from before and after cannot be combined.",
    ),
    GuideLimitationItem(
        "Very thin or fine structures",
        "Wires, hair, spokes, fine mesh, leaf edges. They are smaller than what the reconstruction resolves.",
        "Get closer, use smaller steps (more overlap), more light and a plain contrasting background. Expect thin parts to be broken or missing.",
    ),
    GuideLimitationItem(
        "Dim scenes",
        "Low light forces long exposures and high sensor gain: blur and noise hide the details that need to be matched.",
        "Add light, move slowly and hold still for each photo. The capture screen warns when a photo looks blurred or too dark.",
    ),
)

@Composable
private fun GuideLimitationsSection() {
    SectionTitle("Difficult objects")
    GuideBody(
        "These are limits of the method, not of your technique. Mitigations help; they do not guarantee a clean result.",
    )
    Spacer(Modifier.height(10.dp))
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        GuideLimitationItems.forEach { GuideLimitationCard(it) }
    }
}

@Composable
private fun GuideLimitationCard(item: GuideLimitationItem) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = MaterialTheme.shapes.medium,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth().semantics(mergeDescendants = true) {},
    ) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.WarningAmber, contentDescription = "Limitation", tint = P3.colors.warn,
                     modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
                Text(item.title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurface)
            }
            Spacer(Modifier.height(6.dp))
            Text(item.why, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(8.dp))
            Text("What helps", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold,
                 color = MaterialTheme.colorScheme.onSurface)
            Spacer(Modifier.height(2.dp))
            Text(item.helps, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun GuideAfterCaptureSection() {
    SectionTitle("After capture")
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = MaterialTheme.shapes.medium,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth().clearAndSetSemantics {
            contentDescription = "Photos on this phone are uploaded to the companion computer, which runs the " +
                "reconstruction. The finished 3D model is sent back to the phone."
        },
    ) {
        Row(Modifier.padding(horizontal = 10.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            GuidePipelineStep(Icons.Outlined.PhoneAndroid, "Photos on this phone", MaterialTheme.colorScheme.onSurface,
                              Modifier.weight(1f))
            GuidePipelineArrow()
            GuidePipelineStep(Icons.Outlined.Computer, "Companion computer reconstructs", P3.colors.companion,
                              Modifier.weight(1f))
            GuidePipelineArrow()
            GuidePipelineStep(Icons.Outlined.ViewInAr, "3D model back on the phone", MaterialTheme.colorScheme.onSurface,
                              Modifier.weight(1f))
        }
    }
    Spacer(Modifier.height(10.dp))
    InfoBanner(
        title = "Reconstruction runs on the companion computer, not on the phone",
        body = "The photos are uploaded unmodified to your paired companion computer, which runs " +
            "structure-from-motion (COLMAP) and dense meshing (OpenMVS). This takes minutes to hours " +
            "depending on the photo count and that computer. Without a paired companion you can " +
            "capture and review photos, but no model is produced.",
        tone = Tone.Companion,
    )
    Spacer(Modifier.height(10.dp))
    InfoBanner(
        title = "Coverage shown while capturing is an estimate",
        body = "The coverage ring records where photos were taken from. Which parts of the surface " +
            "were actually reconstructed is only known after the reconstruction has finished.",
        tone = Tone.Provisional,
    )
    Spacer(Modifier.height(10.dp))
    InfoBanner(
        title = "Real-world size is not automatic",
        body = "Photos alone give a correctly shaped model of unknown size. The model is in real units " +
            "only if the AR tracking scale was validated against the reconstruction, or if you enter " +
            "a known reference distance (for example a ruler placed in the scene). Otherwise " +
            "measurements are in arbitrary units and are labelled that way.",
        tone = Tone.Neutral,
    )
}

// ------------------------------------------------------------------------------------------------
// Building blocks
// ------------------------------------------------------------------------------------------------

@Composable
private fun GuideBottomBar(onStartCapture: () -> Unit, onImport: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surfaceContainer, tonalElevation = 3.dp) {
        Row(
            Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedButton(onClick = onImport, modifier = Modifier.weight(1f).heightIn(min = 52.dp)) {
                Icon(Icons.Outlined.PhotoLibrary, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Import photos", textAlign = TextAlign.Center)
            }
            Button(onClick = onStartCapture, modifier = Modifier.weight(1f).heightIn(min = 52.dp)) {
                Icon(Icons.Outlined.PhotoCamera, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Start capture", textAlign = TextAlign.Center)
            }
        }
    }
}

@Composable
private fun GuideBody(text: String) {
    Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun GuideCheckRow(text: String) {
    Row(Modifier.padding(vertical = 5.dp).semantics(mergeDescendants = true) {}, verticalAlignment = Alignment.Top) {
        Icon(Icons.Outlined.CheckCircle, contentDescription = "Do", tint = P3.colors.good, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(10.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
    }
}

@Composable
private fun GuideCrossRow(text: String) {
    Row(Modifier.padding(vertical = 5.dp).semantics(mergeDescendants = true) {}, verticalAlignment = Alignment.Top) {
        Icon(Icons.Outlined.Cancel, contentDescription = "Does not work", tint = P3.colors.bad, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(10.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun GuidePipelineStep(icon: ImageVector, label: String, tint: Color, modifier: Modifier = Modifier) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(30.dp))
        Spacer(Modifier.height(6.dp))
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurface,
             textAlign = TextAlign.Center)
    }
}

@Composable
private fun GuidePipelineArrow() {
    Icon(Icons.AutoMirrored.Outlined.ArrowForward, contentDescription = null,
         tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
}

/** Colours for the diagrams, resolved from the theme in composable scope and handed to DrawScope. */
private data class GuidePalette(
    val line: Color,
    val faint: Color,
    val fill: Color,
    val surface: Color,
    val accent: Color,
    val text: Color,
    val bad: Color,
)

@Composable
private fun guidePalette(): GuidePalette = GuidePalette(
    line = MaterialTheme.colorScheme.onSurfaceVariant,
    faint = MaterialTheme.colorScheme.outlineVariant,
    fill = MaterialTheme.colorScheme.surfaceContainerHighest,
    surface = MaterialTheme.colorScheme.surfaceContainerLow,
    accent = MaterialTheme.colorScheme.primary,
    text = MaterialTheme.colorScheme.onSurface,
    bad = P3.colors.bad,
)

/** A framed Canvas diagram with a text alternative for screen readers. */
@Composable
private fun GuideDiagramCard(
    description: String,
    height: Dp,
    modifier: Modifier = Modifier,
    onDraw: DrawScope.(GuidePalette, TextMeasurer, TextStyle) -> Unit,
) {
    val palette = guidePalette()
    val measurer = rememberTextMeasurer()
    val labelStyle = MaterialTheme.typography.labelSmall.copy(color = palette.text)
    Surface(
        color = palette.surface,
        shape = MaterialTheme.shapes.medium,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = modifier.fillMaxWidth(),
    ) {
        Canvas(
            Modifier
                .fillMaxWidth()
                .height(height)
                .padding(12.dp)
                .semantics { contentDescription = description },
        ) { onDraw(palette, measurer, labelStyle) }
    }
}

/** Small diagram with a verdict below it given as icon + text (never by colour alone). */
@Composable
private fun GuideVerdictPanel(
    ok: Boolean,
    label: String,
    description: String,
    aspect: Float,
    modifier: Modifier = Modifier,
    onDraw: DrawScope.(GuidePalette) -> Unit,
) {
    val palette = guidePalette()
    Column(
        modifier.clearAndSetSemantics { contentDescription = description },
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Surface(
            color = palette.surface,
            shape = MaterialTheme.shapes.small,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        ) {
            Canvas(Modifier.fillMaxWidth().aspectRatio(aspect)) { onDraw(palette) }
        }
        Spacer(Modifier.height(6.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                if (ok) Icons.Outlined.CheckCircle else Icons.Outlined.Cancel,
                contentDescription = null,
                tint = if (ok) P3.colors.good else P3.colors.bad,
                modifier = Modifier.size(16.dp),
            )
            Spacer(Modifier.width(5.dp))
            Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurface)
        }
    }
}

// ------------------------------------------------------------------------------------------------
// Drawing
// ------------------------------------------------------------------------------------------------

private fun guideRad(deg: Float): Float = Math.toRadians(deg.toDouble()).toFloat()

private fun guideDir(deg: Float): Offset {
    val a = guideRad(deg)
    return Offset(cos(a), sin(a))
}

/** Draws [text] with its box aligned on [anchor] ([alignX]/[alignY] in 0..1), kept inside the canvas. */
private fun DrawScope.guideLabel(m: TextMeasurer, text: String, style: TextStyle, anchor: Offset,
                                 alignX: Float = 0.5f, alignY: Float = 0.5f) {
    val layout = m.measure(text, style)
    val x = (anchor.x - layout.size.width * alignX).coerceIn(0f, max(0f, size.width - layout.size.width))
    val y = (anchor.y - layout.size.height * alignY).coerceIn(0f, max(0f, size.height - layout.size.height))
    drawText(layout, topLeft = Offset(x, y))
}

/** A textured object seen from above (or a generic round object): the speckles stand for surface detail. */
private fun DrawScope.guideDrawObject(c: Offset, r: Float, p: GuidePalette) {
    drawCircle(p.fill, r, c)
    drawCircle(p.line, r, c, style = Stroke(1.5.dp.toPx()))
    val speckles = floatArrayOf(-0.48f, -0.22f, 0.08f, -0.55f, 0.42f, -0.16f, -0.12f, 0.08f, 0.30f, 0.40f,
                                -0.42f, 0.44f, 0.58f, 0.22f, -0.05f, 0.62f, 0.20f, 0.05f, -0.62f, 0.12f)
    val dot = max(r * 0.07f, 0.8.dp.toPx())
    for (i in speckles.indices step 2) {
        drawCircle(p.line.copy(alpha = 0.75f), dot, c + Offset(speckles[i] * r, speckles[i + 1] * r))
    }
}

/** A textured object seen from the side, standing on a surface. */
private fun DrawScope.guideDrawObjectSide(c: Offset, halfW: Float, halfH: Float, p: GuidePalette) {
    val topLeft = Offset(c.x - halfW, c.y - halfH)
    val sz = Size(halfW * 2f, halfH * 2f)
    val corner = CornerRadius(halfW * 0.45f)
    drawRoundRect(p.fill, topLeft, sz, corner)
    drawRoundRect(p.line, topLeft, sz, corner, style = Stroke(1.5.dp.toPx()))
    val speckles = floatArrayOf(-0.4f, -0.6f, 0.3f, -0.4f, -0.1f, -0.1f, 0.45f, 0.15f, -0.45f, 0.3f, 0.1f, 0.55f, 0.0f, -0.75f)
    val dot = max(halfW * 0.09f, 0.8.dp.toPx())
    for (i in speckles.indices step 2) {
        drawCircle(p.line.copy(alpha = 0.75f), dot, c + Offset(speckles[i] * halfW, speckles[i + 1] * halfH))
    }
}

/** A small camera body at [pos] whose lens points at [lookAt]. */
private fun DrawScope.guideDrawCamera(pos: Offset, lookAt: Offset, s: Float, color: Color) {
    val deg = Math.toDegrees(atan2((lookAt.y - pos.y).toDouble(), (lookAt.x - pos.x).toDouble())).toFloat()
    rotate(deg, pivot = pos) {
        drawRoundRect(color, topLeft = Offset(pos.x - s * 0.5f, pos.y - s * 0.7f), size = Size(s, s * 1.4f),
                      cornerRadius = CornerRadius(s * 0.2f))
        drawRect(color, topLeft = Offset(pos.x + s * 0.5f, pos.y - s * 0.32f), size = Size(s * 0.38f, s * 0.64f))
    }
}

/** Field-of-view wedge from [from] towards [toward]. */
private fun DrawScope.guideDrawFov(from: Offset, toward: Offset, halfAngleDeg: Float, length: Float, color: Color) {
    val a = atan2(toward.y - from.y, toward.x - from.x)
    val h = guideRad(halfAngleDeg)
    val path = Path().apply {
        moveTo(from.x, from.y)
        lineTo(from.x + cos(a - h) * length, from.y + sin(a - h) * length)
        lineTo(from.x + cos(a + h) * length, from.y + sin(a + h) * length)
        close()
    }
    drawPath(path, color)
}

/** Arrow head at [tip] for a stroke travelling in direction [dir]. */
private fun DrawScope.guideArrowHead(tip: Offset, dir: Offset, len: Float, color: Color, stroke: Float) {
    val a = atan2(dir.y, dir.x) + Math.PI.toFloat()
    for (s in floatArrayOf(-0.5f, 0.5f)) {
        drawLine(color, tip, tip + Offset(cos(a + s), sin(a + s)) * len, stroke, cap = StrokeCap.Round)
    }
}

private fun DrawScope.guideDash(): PathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 4.dp.toPx()))

/** Top-down view: 30 camera stations on a ring, 12° apart, neighbouring views overlapping. */
private fun DrawScope.guideDrawOrbit(p: GuidePalette, m: TextMeasurer, style: TextStyle) {
    val c = Offset(size.width / 2f, size.height / 2f)
    val r = min(size.width, size.height) * 0.40f
    val stroke = 1.dp.toPx()
    val top = -90f

    drawCircle(p.faint, r, c, style = Stroke(stroke, pathEffect = guideDash()))

    // Three neighbouring views: their fields of view overlap almost completely on the object.
    for (k in -1..1) {
        guideDrawFov(c + guideDir(top + k * 12f) * r, c, halfAngleDeg = 19f, length = r * 1.3f,
                     color = p.accent.copy(alpha = 0.15f))
    }
    guideDrawObject(c, r * 0.27f, p)

    // 30 stations, one every 12°.
    for (i in 0 until 30) {
        val pos = c + guideDir(top + i * 12f) * r
        if (i == 0 || i == 1 || i == 29) guideDrawCamera(pos, c, 8.dp.toPx(), p.accent)
        else drawCircle(p.line, 2.5.dp.toPx(), pos)
    }
    guideLabel(m, "12° apart", style, c + guideDir(top + 30f) * (r + 12.dp.toPx()), alignX = 0f, alignY = 0.7f)

    // Walking direction, just outside the ring.
    val ra = r * 1.17f
    val startDeg = 22f
    val sweepDeg = 44f
    drawArc(p.text, startAngle = startDeg, sweepAngle = sweepDeg, useCenter = false,
            topLeft = Offset(c.x - ra, c.y - ra), size = Size(ra * 2f, ra * 2f),
            style = Stroke(2.dp.toPx(), cap = StrokeCap.Round))
    val endDeg = startDeg + sweepDeg
    guideArrowHead(c + guideDir(endDeg) * ra, guideDir(endDeg + 90f), 7.dp.toPx(), p.text, 2.dp.toPx())
    guideLabel(m, "you walk", style, c + guideDir(startDeg) * (ra + 10.dp.toPx()), alignX = 0f, alignY = 0.5f)
}

/** Side view: low / mid / high rings around the object. */
private fun DrawScope.guideDrawRings(p: GuidePalette, m: TextMeasurer, style: TextStyle) {
    val w = size.width
    val h = size.height
    val ground = h * 0.86f
    val halfH = h * 0.10f
    val halfW = halfH * 0.8f
    val oc = Offset(w / 2f, ground - halfH)
    val ringR = min(w * 0.33f, h * 0.66f)
    val stroke = 1.dp.toPx()

    drawLine(p.faint, Offset(0f, ground), Offset(w, ground), stroke)

    val elevations = floatArrayOf(8f, 35f, 62f)
    val names = arrayOf("low", "mid", "high")
    for (i in elevations.indices) {
        val e = guideRad(elevations[i])
        val dx = cos(e) * ringR
        val y = oc.y - sin(e) * ringR
        // The ring itself, seen almost edge-on.
        drawOval(p.faint, topLeft = Offset(oc.x - dx, y - dx * 0.11f), size = Size(dx * 2f, dx * 0.22f),
                 style = Stroke(stroke, pathEffect = guideDash()))
        for (side in intArrayOf(-1, 1)) {
            val pos = Offset(oc.x + side * dx, y)
            drawLine(p.accent.copy(alpha = 0.45f), pos, oc, stroke, pathEffect = guideDash())
            guideDrawCamera(pos, oc, 8.dp.toPx(), p.accent)
        }
        guideLabel(m, names[i], style, Offset(oc.x + dx + 14.dp.toPx(), y), alignX = 0f, alignY = 0.5f)
    }
    guideDrawObjectSide(oc, halfW, halfH, p)
}

private enum class GuideFraming { TooSmall, Good, Cropped }

/** What the phone screen shows for three framings of the same object. */
private fun DrawScope.guideDrawFraming(kind: GuideFraming, p: GuidePalette) {
    val w = size.width
    val h = size.height
    val c = Offset(w / 2f, h / 2f)
    val r = when (kind) {
        GuideFraming.TooSmall -> w * 0.10f
        GuideFraming.Good -> w * 0.35f
        GuideFraming.Cropped -> w * 0.64f
    }
    val oc = if (kind == GuideFraming.Cropped) c + Offset(w * 0.14f, h * 0.07f) else c
    clipRect { guideDrawObject(oc, r, p) }

    if (kind == GuideFraming.Good) {
        // The capture screen's framing guide: corner brackets and a centre reticle.
        val inset = w * 0.08f
        val arm = w * 0.13f
        val sw = 1.5.dp.toPx()
        val left = inset
        val right = w - inset
        val topY = c.y - (w / 2f - inset)
        val bottomY = c.y + (w / 2f - inset)
        for (x in floatArrayOf(left, right)) for (y in floatArrayOf(topY, bottomY)) {
            val sx = if (x == left) 1f else -1f
            val sy = if (y == topY) 1f else -1f
            drawLine(p.accent, Offset(x, y), Offset(x + sx * arm, y), sw, cap = StrokeCap.Round)
            drawLine(p.accent, Offset(x, y), Offset(x, y + sy * arm), sw, cap = StrokeCap.Round)
        }
        val ret = w * 0.05f
        drawLine(p.accent, Offset(c.x - ret, c.y), Offset(c.x + ret, c.y), sw, cap = StrokeCap.Round)
        drawLine(p.accent, Offset(c.x, c.y - ret), Offset(c.x, c.y + ret), sw, cap = StrokeCap.Round)
    }
}

/** Side view of the object under a large soft source, or under one small hard source. */
private fun DrawScope.guideDrawLighting(soft: Boolean, p: GuidePalette) {
    val w = size.width
    val h = size.height
    val ground = h * 0.74f
    val r = h * 0.20f
    val oc = Offset(w * 0.5f, ground - r)
    val stroke = 1.dp.toPx()
    drawLine(p.faint, Offset(w * 0.06f, ground), Offset(w * 0.94f, ground), stroke)

    if (soft) {
        // A large diffuse source (overcast sky, softbox) with gentle light from many directions.
        drawRoundRect(p.text.copy(alpha = 0.6f), topLeft = Offset(w * 0.14f, h * 0.07f), size = Size(w * 0.72f, h * 0.05f),
                      cornerRadius = CornerRadius(h * 0.025f))
        for (i in 0..6) {
            val x = w * (0.20f + i * 0.10f)
            drawLine(p.text.copy(alpha = 0.32f), Offset(x, h * 0.17f), Offset(x + (oc.x - x) * 0.22f, h * 0.29f),
                     stroke, cap = StrokeCap.Round)
        }
        drawOval(p.line.copy(alpha = 0.20f), topLeft = Offset(oc.x - r * 1.25f, ground - r * 0.12f),
                 size = Size(r * 2.5f, r * 0.30f))
        guideDrawObject(oc, r, p)
    } else {
        // One small bright source: hard shadow on the ground, a dark side and a glare spot.
        val lamp = Offset(w * 0.15f, h * 0.13f)
        drawCircle(p.text, h * 0.045f, lamp)
        val toObj = oc - lamp
        val len = sqrt(toObj.x * toObj.x + toObj.y * toObj.y)
        val dirBase = Math.toDegrees(atan2(toObj.y.toDouble(), toObj.x.toDouble())).toFloat()
        for (k in -1..1) {
            val d = guideDir(dirBase + k * 14f)
            drawLine(p.text.copy(alpha = 0.7f), lamp + d * (h * 0.08f), lamp + d * (len * 0.42f),
                     1.5.dp.toPx(), cap = StrokeCap.Round)
        }
        val shadow = Path().apply {
            moveTo(oc.x - r * 0.55f, ground)
            lineTo(oc.x + r * 0.95f, ground)
            lineTo(w * 0.96f, ground + h * 0.17f)
            lineTo(oc.x + r * 1.05f, ground + h * 0.17f)
            close()
        }
        drawPath(shadow, p.line.copy(alpha = 0.70f))
        guideDrawObject(oc, r, p)
        drawArc(p.line.copy(alpha = 0.62f), startAngle = -45f, sweepAngle = 180f, useCenter = false,
                topLeft = Offset(oc.x - r, oc.y - r), size = Size(r * 2f, r * 2f))
        drawCircle(p.text, r * 0.16f, oc + Offset(-r * 0.42f, -r * 0.42f))
    }
}

/** The invalid setup: fixed phone, turning object, visible static background. */
private fun DrawScope.guideDrawTurntable(p: GuidePalette, m: TextMeasurer, style: TextStyle) {
    val w = size.width
    val h = size.height
    val floor = h * 0.68f
    val stroke = 1.dp.toPx()
    val labelY = h - 8.dp.toPx()

    val phone = Offset(w * 0.10f, floor - h * 0.24f)
    val tc = Offset(w * 0.48f, floor)
    val objHalfH = h * 0.15f
    val objHalfW = min(w * 0.06f, objHalfH * 0.75f)
    val obj = Offset(tc.x, floor - objHalfH - h * 0.02f)

    // What the fixed phone sees: the object and the background behind it.
    guideDrawFov(phone, obj, halfAngleDeg = 17f, length = w * 0.88f, color = p.accent.copy(alpha = 0.12f))
    drawLine(p.faint, Offset(0f, floor), Offset(w, floor), stroke)

    // Static background with plenty of visible detail (a shelf).
    val bgL = w * 0.80f
    val bgR = w * 0.97f
    val bgT = h * 0.06f
    val bgH = floor - bgT
    drawRect(p.fill, Offset(bgL, bgT), Size(bgR - bgL, bgH))
    drawRect(p.line, Offset(bgL, bgT), Size(bgR - bgL, bgH), style = Stroke(stroke))
    val bookXs = floatArrayOf(0.10f, 0.26f, 0.48f, 0.66f)
    val bookWs = floatArrayOf(0.12f, 0.16f, 0.12f, 0.20f)
    val bookHs = floatArrayOf(0.70f, 0.50f, 0.78f, 0.58f)
    for (row in 0 until 4) {
        val y1 = bgT + bgH * (row + 1) / 4f
        if (row < 3) drawLine(p.line, Offset(bgL, y1), Offset(bgR, y1), stroke)
        for (b in bookXs.indices) {
            val k = (b + row) % bookXs.size
            val bh = bgH / 4f * bookHs[k]
            drawRect(p.line.copy(alpha = 0.55f), Offset(bgL + (bgR - bgL) * bookXs[b], y1 - bh),
                     Size((bgR - bgL) * bookWs[b], bh))
        }
    }

    // Turntable and the object on it.
    val rx = w * 0.13f
    val ry = h * 0.045f
    drawOval(p.fill, Offset(tc.x - rx, tc.y - ry), Size(rx * 2f, ry * 2f))
    drawOval(p.line, Offset(tc.x - rx, tc.y - ry), Size(rx * 2f, ry * 2f), style = Stroke(stroke))
    guideDrawObjectSide(obj, objHalfW, objHalfH, p)

    // Rotation arrow around the turntable.
    val ax = rx * 1.30f
    val ay = ry * 2.3f
    val arrowStroke = 2.dp.toPx()
    drawArc(p.bad, startAngle = 15f, sweepAngle = 150f, useCenter = false,
            topLeft = Offset(tc.x - ax, tc.y - ay), size = Size(ax * 2f, ay * 2f),
            style = Stroke(arrowStroke, cap = StrokeCap.Round))
    val endA = guideRad(165f)
    val tip = Offset(tc.x + cos(endA) * ax, tc.y + sin(endA) * ay)
    guideArrowHead(tip, Offset(-sin(endA) * ax, cos(endA) * ay), 7.dp.toPx(), p.bad, arrowStroke)

    // The phone, fixed in place on a stand.
    drawLine(p.line, phone, Offset(phone.x, floor), 1.5.dp.toPx())
    drawLine(p.line, Offset(phone.x - 9.dp.toPx(), floor), Offset(phone.x + 9.dp.toPx(), floor), 2.5.dp.toPx(),
             cap = StrokeCap.Round)
    guideDrawCamera(phone, obj, 10.dp.toPx(), p.accent)

    guideLabel(m, "phone: still", style, Offset(0f, labelY), alignX = 0f, alignY = 1f)
    guideLabel(m, "object: turning", style, Offset(tc.x, labelY), alignX = 0.5f, alignY = 1f)
    guideLabel(m, "background: still", style, Offset(w, labelY), alignX = 1f, alignY = 1f)
}

@Preview(name = "Capture guide", showBackground = true, backgroundColor = 0xFF0D1012, widthDp = 380, heightDp = 3600)
@Composable
private fun GuideScreenPreview() {
    Pocket3DTheme(darkTheme = true) {
        CaptureGuideScreen(onStartCapture = {}, onImport = {}, onBack = {})
    }
}
