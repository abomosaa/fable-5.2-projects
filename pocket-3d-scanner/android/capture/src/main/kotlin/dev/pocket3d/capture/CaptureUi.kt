package dev.pocket3d.capture

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import dev.pocket3d.capture.engine.EngineInfo
import dev.pocket3d.capture.engine.EngineKind
import dev.pocket3d.capture.engine.ViewpointSource
import dev.pocket3d.core.capture.CoverageGrid
import dev.pocket3d.design.InfoBanner
import dev.pocket3d.design.LabeledValue
import dev.pocket3d.design.P3
import dev.pocket3d.design.Pocket3DTheme
import dev.pocket3d.design.SectionTitle
import dev.pocket3d.design.StatusPill
import dev.pocket3d.design.Tone
import kotlin.math.cos
import kotlin.math.sin

internal fun CoverageKind.label(): String = when (this) {
    CoverageKind.TRACKED -> "Viewpoint coverage — tracked"
    CoverageKind.ESTIMATED -> "Viewpoint coverage — estimated from phone orientation"
    CoverageKind.MIXED -> "Viewpoint coverage — partly tracked, partly estimated from phone orientation"
    CoverageKind.NONE -> "Viewpoint coverage — not available (no orientation sensor)"
}

internal fun CoverageKind.pill(): Pair<String, Tone> = when (this) {
    CoverageKind.TRACKED -> "TRACKED" to Tone.Good
    CoverageKind.ESTIMATED -> "ESTIMATED" to Tone.Provisional
    CoverageKind.MIXED -> "PARTLY ESTIMATED" to Tone.Provisional
    CoverageKind.NONE -> "UNKNOWN" to Tone.Neutral
}

/** Radius (fraction of the ring radius) at which a viewpoint of [elevationDeg] is drawn: the horizon is the rim, straight above is the centre. */
private fun elevationRadius(elevationDeg: Double): Float = (1.0 - elevationDeg.coerceIn(0.0, 90.0) / 90.0).toFloat()

private const val RING_HOLE = 0.12f

/**
 * Top-down map of where photos were taken from: 12 azimuth sectors × 3 elevation bands (outer
 * ring = low, middle = mid, inner = high viewpoints; the object is the dot in the middle).
 * A cell is filled only if a stored photo was taken from it. The marker is the current viewpoint.
 */
@Composable
internal fun CoverageRing(
    counts: List<List<Int>>,
    kind: CoverageKind,
    viewpoint: Pair<Double, Double>?,
    modifier: Modifier = Modifier,
) {
    val filled = if (kind == CoverageKind.TRACKED) P3.colors.good else P3.colors.provisional
    val empty = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.28f)
    val markerColor = MaterialTheme.colorScheme.onSurface
    val objectColor = MaterialTheme.colorScheme.onSurfaceVariant
    val bins = counts.firstOrNull()?.size ?: CoverageGrid.AZIMUTH_BINS
    val sectors = (0 until bins).count { a -> counts.any { it.getOrElse(a) { 0 } > 0 } }
    val perBand = counts.map { row -> row.count { it > 0 } }
    val description = buildString {
        append(kind.label()).append(". ")
        append("$sectors of $bins directions around the object have photos. ")
        append("Low ring ${perBand.getOrElse(0) { 0 }}, middle ring ${perBand.getOrElse(1) { 0 }}, high ring ${perBand.getOrElse(2) { 0 }} of $bins. ")
        append("Surface coverage is only verified after reconstruction.")
    }
    Canvas(modifier.semantics { contentDescription = description }) {
        val radius = size.minDimension / 2f
        val center = Offset(size.width / 2f, size.height / 2f)
        // Band edges at the radii of 20° and 50° elevation, so the live marker lands in the cell it would fill.
        val edges = floatArrayOf(1f, elevationRadius(CoverageGrid.ELEVATION_EDGES_DEG[0]),
                                 elevationRadius(CoverageGrid.ELEVATION_EDGES_DEG[1]), RING_HOLE)
        val sweep = 360f / bins
        val gapDeg = 3f
        val gapPx = 1.5.dp.toPx()
        for (band in 0 until CoverageGrid.BANDS) {
            val outer = edges[band] * radius - gapPx / 2
            val inner = edges[band + 1] * radius + gapPx / 2
            val mid = (outer + inner) / 2f
            val thickness = (outer - inner).coerceAtLeast(1f)
            for (a in 0 until bins) {
                val has = counts.getOrNull(band)?.getOrNull(a)?.let { it > 0 } == true
                // Azimuth grows counter-clockwise seen from above; canvas angles grow clockwise.
                val start = -(a + 1) * sweep + gapDeg / 2
                drawArc(
                    color = if (has) filled else empty,
                    startAngle = start, sweepAngle = sweep - gapDeg, useCenter = false,
                    topLeft = Offset(center.x - mid, center.y - mid), size = Size(mid * 2, mid * 2),
                    style = Stroke(width = if (has) thickness else thickness * 0.35f, cap = StrokeCap.Butt),
                )
            }
        }
        drawCircle(objectColor, radius = RING_HOLE * radius * 0.55f, center = center)
        if (viewpoint != null) {
            val az = Math.toRadians(viewpoint.first)
            val r = elevationRadius(viewpoint.second).coerceIn(RING_HOLE, 1f) * radius * 0.96f
            val p = Offset(center.x + r * cos(az).toFloat(), center.y - r * sin(az).toFloat())
            drawCircle(Color.Black.copy(alpha = 0.55f), radius = 5.5.dp.toPx(), center = p)
            drawCircle(markerColor, radius = 4.dp.toPx(), center = p, style = Stroke(width = 2.dp.toPx()))
            drawCircle(markerColor, radius = 1.3.dp.toPx(), center = p)
        }
    }
}

/** Ring plus the honest label: what the ring shows, how it is known, and what it does not prove. */
@Composable
internal fun CoverageCard(
    counts: List<List<Int>>,
    kind: CoverageKind,
    viewpoint: Pair<Double, Double>?,
    photosWithoutViewpoint: Int,
    segmentCount: Int,
    modifier: Modifier = Modifier,
    /** Short screens: smaller ring and one combined line of text. */
    compact: Boolean = false,
) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        CoverageRing(counts, kind, viewpoint, Modifier.size(if (compact) 68.dp else 92.dp))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            val (pillText, pillTone) = kind.pill()
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Viewpoint coverage", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurface)
                Spacer(Modifier.width(8.dp))
                StatusPill(pillText, pillTone)
            }
            Spacer(Modifier.height(2.dp))
            val how = when (kind) {
                CoverageKind.TRACKED -> "Tracked camera positions around the object."
                CoverageKind.ESTIMATED -> "Estimated from phone orientation, assuming the camera points at the object."
                CoverageKind.MIXED -> "Partly tracked positions, partly estimated from phone orientation."
                CoverageKind.NONE -> "This phone has no orientation sensor, so viewpoints are unknown."
            }
            val extras = buildList {
                if (photosWithoutViewpoint > 0)
                    add("$photosWithoutViewpoint photo${if (photosWithoutViewpoint == 1) "" else "s"} without a known viewpoint not shown.")
                if (segmentCount > 1) add("$segmentCount tracking segments, not aligned with each other.")
                add("Surface coverage is only verified after reconstruction.")
            }.joinToString(" ")
            if (compact) {
                Text("$how $extras", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                Text(how, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(extras, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.85f))
            }
        }
    }
}

/**
 * Subtle framing aid: the object should fill the rounded frame (about 60–80 % of the picture).
 * The centre reticle is what "Set object" aims with.
 */
@Composable
internal fun FramingGuide(modifier: Modifier = Modifier, emphasiseReticle: Boolean = false) {
    Canvas(modifier) {
        val w = size.width * 0.74f
        val h = size.height * 0.70f
        val topLeft = Offset((size.width - w) / 2f, (size.height - h) / 2f)
        val corner = CornerRadius(28.dp.toPx())
        // Dark under-stroke so the guide stays visible on bright scenes.
        drawRoundRect(Color.Black.copy(alpha = 0.25f), topLeft, Size(w, h), corner, style = Stroke(width = 3.dp.toPx()))
        drawRoundRect(Color.White.copy(alpha = 0.55f), topLeft, Size(w, h), corner, style = Stroke(width = 1.2.dp.toPx()))
        val c = Offset(size.width / 2f, size.height / 2f)
        val arm = (if (emphasiseReticle) 11.dp else 7.dp).toPx()
        val gap = 3.dp.toPx()
        val alpha = if (emphasiseReticle) 0.95f else 0.6f
        for ((dx, dy) in listOf(1f to 0f, -1f to 0f, 0f to 1f, 0f to -1f)) {
            val from = Offset(c.x + dx * gap, c.y + dy * gap)
            val to = Offset(c.x + dx * arm, c.y + dy * arm)
            drawLine(Color.Black.copy(alpha = 0.35f), from, to, strokeWidth = 3.dp.toPx(), cap = StrokeCap.Round)
            drawLine(Color.White.copy(alpha = alpha), from, to, strokeWidth = 1.5.dp.toPx(), cap = StrokeCap.Round)
        }
        if (emphasiseReticle) drawCircle(Color.White.copy(alpha = 0.9f), radius = 1.5.dp.toPx(), center = c)
    }
}

/** A specific warning as icon + text on a dark chip (readable over any camera image). */
@Composable
internal fun WarningChip(text: String, tone: Tone = Tone.Warn, modifier: Modifier = Modifier) {
    val color = when (tone) {
        Tone.Bad -> P3.colors.bad
        Tone.Good -> P3.colors.good
        Tone.Provisional -> P3.colors.provisional
        Tone.Companion -> P3.colors.companion
        Tone.Warn -> P3.colors.warn
        Tone.Neutral -> MaterialTheme.colorScheme.onSurface
    }
    Surface(color = P3.colors.scrim, contentColor = MaterialTheme.colorScheme.onSurface, shape = RoundedCornerShape(50),
            modifier = modifier) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.WarningAmber, contentDescription = null, tint = color, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
            Text(text, style = MaterialTheme.typography.labelMedium)
        }
    }
}

/** Large shutter, bottom centre. Shows a spinner while a photo is being taken or stored. */
@Composable
internal fun ShutterButton(enabled: Boolean, busy: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val ring = MaterialTheme.colorScheme.onSurface
    val alpha = if (enabled) 1f else 0.38f
    Box(
        modifier
            .size(80.dp)
            .clip(CircleShape)
            .border(3.dp, ring.copy(alpha = alpha), CircleShape)
            .clickable(
                enabled = enabled && !busy, role = Role.Button, onClickLabel = "Take photo", onClick = onClick,
                interactionSource = remember { MutableInteractionSource() }, indication = ripple(bounded = true),
            )
            .semantics {
                contentDescription = "Take photo"
                stateDescription = when {
                    busy -> "Saving photo"
                    !enabled -> "Not available"
                    else -> "Ready"
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(62.dp).clip(CircleShape).background(ring.copy(alpha = alpha * 0.92f)))
        if (busy) CircularProgressIndicator(Modifier.size(34.dp), color = MaterialTheme.colorScheme.surface, strokeWidth = 3.dp)
    }
}

/** What the capture screen does and — just as important — what it cannot know. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CaptureHelpSheet(engineKind: EngineKind?, info: EngineInfo, onDismiss: () -> Unit) {
    val context = LocalContext.current
    var caps by remember { mutableStateOf<DeviceCapabilities?>(null) }
    LaunchedEffect(Unit) { caps = try { CapabilityProbe.probe(context) } catch (t: Throwable) { null } }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).navigationBarsPadding()) {
            Text("How capture works", style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.height(8.dp))
            Text(
                "Leave the object where it is and walk around it. Keep the whole object inside the frame, take a photo " +
                    "about every 12° (roughly 30 per circle), then repeat from a higher and, if possible, a lower angle.",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            SectionTitle("This session")
            when {
                engineKind == EngineKind.AR -> InfoBanner(
                    title = "AR tracked",
                    body = "ARCore tracks where the phone is. After “Set object” the ring shows real camera positions " +
                        "around the object. If tracking is lost, auto capture pauses; photos taken meanwhile are stored " +
                        "without a position. When tracking returns a new segment starts — positions before and after " +
                        "are aligned later by the reconstruction, never assumed. The app warns if you turn on the spot " +
                        "or if the picture changes while the phone stands still.",
                    tone = Tone.Good)
                info.viewpointSource == ViewpointSource.IMU -> InfoBanner(
                    title = "Estimated from phone orientation",
                    body = "Without AR tracking the phone only knows where it points, not where it is. The ring assumes " +
                        "the camera is aimed at the object, so standing still and turning the phone fills it just like " +
                        "walking around the object would. The app cannot detect that mistake, nor an object that is " +
                        "being rotated, in this mode — walk around the object.",
                    tone = Tone.Provisional)
                else -> InfoBanner(
                    title = "No viewpoint guidance",
                    body = "This phone has neither AR tracking nor an orientation sensor. Photos are taken normally, but " +
                        "the app cannot estimate from where. Count your steps around the object.",
                    tone = Tone.Warn)
            }

            SectionTitle("What the coverage ring means")
            Text(
                "Each cell is a direction from which the object is seen: 12 directions around it, in three rings — outer " +
                    "for low, middle for medium, inner for high viewpoints. A cell fills when a stored photo was taken " +
                    "from there; many photos from one spot fill one cell. It shows viewpoints, not results: whether every " +
                    "surface was actually reconstructed is only known after the reconstruction on the companion computer.",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            SectionTitle("Warnings while framing")
            Text(
                "Blur risk (moving faster than about 25°/s or a soft live image), too dark, overexposed, too far from " +
                    "your other photos (little overlap), and same view as an existing photo. Auto capture skips weak " +
                    "frames; with the shutter you decide whether to keep them.",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            SectionTitle("This phone")
            if (info.photoWidth > 0) LabeledValue("Photo size in this mode", "${info.photoWidth} × ${info.photoHeight}")
            val c = caps
            if (c == null) {
                Text("Checking capabilities…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                val depth = info.arDepthSupported ?: c.arCoreDepthSupported
                LabeledValue("ARCore depth", when (depth) {
                    true -> "Detected, not used"
                    false -> "Not supported"
                    null -> "Unknown until AR is opened"
                })
                LabeledValue("Depth camera", if (c.hardwareDepthCamera) "Detected, not used" else "None")
                LabeledValue("Orientation sensor", if (c.rotationVectorSensor) "Present" else "Missing")
                Text(
                    "Depth is not used for reconstruction in this version; the model is computed from the photos alone.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            info.lock.unsupportedText?.takeIf { engineKind == EngineKind.CAMERA }?.let {
                Spacer(Modifier.height(8.dp))
                InfoBanner(title = "Focus & exposure lock", body = it, tone = Tone.Warn)
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Preview(widthDp = 360, heightDp = 160)
@Composable
private fun CoverageCardPreview() {
    Pocket3DTheme(darkTheme = true) {
        Surface {
            val counts = List(3) { band -> List(12) { a -> if (band == 0 && a < 7 || band == 1 && a in 2..4) 1 else 0 } }
            CoverageCard(counts, CoverageKind.ESTIMATED, 200.0 to 30.0, photosWithoutViewpoint = 2, segmentCount = 1,
                         modifier = Modifier.padding(12.dp))
        }
    }
}
