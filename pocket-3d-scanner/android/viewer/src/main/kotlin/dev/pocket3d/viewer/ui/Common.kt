package dev.pocket3d.viewer.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.exifinterface.media.ExifInterface
import dev.pocket3d.core.capture.CoverageGrid
import dev.pocket3d.viewer.scene.EvidenceStats
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.util.Locale
import kotlin.math.max
import kotlin.math.roundToInt

internal fun formatCount(n: Int): String = String.format(Locale.US, "%,d", n)

internal fun formatPercent(fraction: Float): String {
    val p = fraction * 100f
    return when {
        p <= 0f -> "0%"
        p < 0.1f -> "<0.1%"
        p < 10f -> String.format(Locale.US, "%.1f%%", p)
        else -> "${p.roundToInt()}%"
    }
}

@Composable
internal fun Hint(text: String, modifier: Modifier = Modifier) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = modifier)
}

/** A full-width switch row with a 48dp touch target; the whole row toggles. */
@Composable
internal fun ToggleRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit, modifier: Modifier = Modifier,
                       enabled: Boolean = true, supporting: String? = null) {
    Row(
        modifier.fillMaxWidth().heightIn(min = 48.dp)
            .toggleable(checked, enabled = enabled, role = Role.Switch, onValueChange = onChange),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyMedium,
                 color = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
            if (supporting != null) Hint(supporting)
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked, onCheckedChange = null, enabled = enabled)
    }
}

/** Decodes a photo file for display: downsampled to about [maxSide] pixels and rotated upright per EXIF. */
internal suspend fun loadPhoto(path: String, fallbackExifOrientation: Int, maxSide: Int = 1600): Bitmap? = withContext(Dispatchers.IO) {
    try {
        val file = File(path)
        if (!file.isFile) return@withContext null
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(path, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return@withContext null
        var sample = 1
        while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
        val bmp = BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return@withContext null
        var orientation = try {
            ExifInterface(path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_UNDEFINED)
        } catch (e: Exception) { ExifInterface.ORIENTATION_UNDEFINED }
        if (orientation == ExifInterface.ORIENTATION_UNDEFINED) orientation = fallbackExifOrientation
        val m = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.setScale(-1f, 1f)
            ExifInterface.ORIENTATION_ROTATE_180 -> m.setRotate(180f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.setScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { m.setRotate(90f); m.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_90 -> m.setRotate(90f)
            ExifInterface.ORIENTATION_TRANSVERSE -> { m.setRotate(-90f); m.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_270 -> m.setRotate(-90f)
            else -> return@withContext bmp
        }
        val rotated = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
        if (rotated !== bmp) bmp.recycle()
        rotated
    } catch (e: Exception) {
        null
    } catch (e: OutOfMemoryError) {
        null
    }
}

internal sealed interface PhotoState {
    data object Loading : PhotoState
    data object Missing : PhotoState
    class Ready(val image: ImageBitmap) : PhotoState
}

@Composable
internal fun rememberPhoto(path: String?, exifOrientation: Int): PhotoState {
    val state by produceState<PhotoState>(if (path == null) PhotoState.Missing else PhotoState.Loading, path, exifOrientation) {
        value = if (path == null) PhotoState.Missing
        else loadPhoto(path, exifOrientation)?.let { PhotoState.Ready(it.asImageBitmap()) } ?: PhotoState.Missing
    }
    return state
}

/** Photo of a registered camera, upright. Shows why when it is not available. */
@Composable
internal fun FramePhoto(path: String?, exifOrientation: Int, description: String, modifier: Modifier = Modifier) {
    val photo = rememberPhoto(path, exifOrientation)
    Box(modifier.clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceContainerHighest),
        contentAlignment = Alignment.Center) {
        when (photo) {
            is PhotoState.Ready -> Image(photo.image, description, Modifier.fillMaxWidth(), contentScale = ContentScale.Fit)
            PhotoState.Loading -> CircularProgressIndicator(Modifier.padding(32.dp).size(28.dp))
            PhotoState.Missing -> Text("The photo file is not on this phone.", Modifier.padding(24.dp),
                                       style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/**
 * Viewpoint coverage as a small 12 × 3 grid (columns = directions around the object, rows =
 * height bands, highest on top). Filled cells carry a dot as well as a colour.
 */
@Composable
internal fun CoverageGridView(grid: CoverageGrid, modifier: Modifier = Modifier) {
    val filled = MaterialTheme.colorScheme.primary
    val empty = MaterialTheme.colorScheme.outlineVariant
    val onFilled = MaterialTheme.colorScheme.onPrimary
    val desc = "Registered viewpoints: ${grid.azimuthCovered} of ${grid.azimuthBins} directions around the object have photos, " +
        "in ${grid.bandsCovered} of ${CoverageGrid.BANDS} height bands."
    Canvas(modifier.fillMaxWidth().aspectRatio(grid.azimuthBins / 3.4f).semantics { contentDescription = desc }) {
        val cols = grid.azimuthBins
        val gap = 2.dp.toPx()
        val cw = (size.width - gap * (cols - 1)) / cols
        val ch = (size.height - gap * (CoverageGrid.BANDS - 1)) / CoverageGrid.BANDS
        for (band in 0 until CoverageGrid.BANDS) for (a in 0 until cols) {
            val n = grid.counts[band][a]
            val row = CoverageGrid.BANDS - 1 - band
            val tl = Offset(a * (cw + gap), row * (ch + gap))
            if (n > 0) {
                drawRect(filled, tl, Size(cw, ch))
                drawCircle(onFilled, minOf(cw, ch) * 0.16f, tl + Offset(cw / 2f, ch / 2f))
            } else {
                drawRect(empty, tl, Size(cw, ch), style = androidx.compose.ui.graphics.drawscope.Stroke(1.dp.toPx()))
            }
        }
    }
}

internal val EvidenceLow = Color(0xFF002454)
internal val EvidenceMid = Color(0xFF7D7B78)
internal val EvidenceHigh = Color(0xFFFFE945)
internal val RepairedA = Color(0xFFF24D9E)
internal val RepairedB = Color(0xFF1F1A29)

internal fun evidenceRamp(c: Float): Color {
    val t = c.coerceIn(0f, 1f)
    fun mix(a: Color, b: Color, k: Float) = Color(a.red + (b.red - a.red) * k, a.green + (b.green - a.green) * k, a.blue + (b.blue - a.blue) * k)
    return if (t < 0.5f) mix(EvidenceLow, EvidenceMid, t * 2f) else mix(EvidenceMid, EvidenceHigh, t * 2f - 1f)
}

/** Diagonal hatch lines over the current clip, used by the legends to match the 3D view. */
internal fun DrawScope.hatch(topLeft: Offset, size: Size, color: Color, spacing: Float, width: Float, rising: Boolean) {
    clipRect(topLeft.x, topLeft.y, topLeft.x + size.width, topLeft.y + size.height) {
        var x = -size.height
        while (x < size.width) {
            if (rising) drawLine(color, Offset(topLeft.x + x, topLeft.y + size.height), Offset(topLeft.x + x + size.height, topLeft.y), width)
            else drawLine(color, Offset(topLeft.x + x, topLeft.y), Offset(topLeft.x + x + size.height, topLeft.y + size.height), width)
            x += spacing
        }
    }
}

/** Legend of the evidence view: same ramp and the same hatching as the shader. */
@Composable
internal fun EvidenceLegend(modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().semantics(mergeDescendants = true) {
        contentDescription = "Evidence legend: yellow means well supported by photos, grey with single hatching means weak support, " +
            "dark blue with cross hatching means no photographic evidence, pink stripes mean repaired synthetic surface."
    }) {
        Canvas(Modifier.fillMaxWidth().height(22.dp).clip(RoundedCornerShape(6.dp))) {
            val steps = 48
            val sw = size.width / steps
            for (i in 0 until steps) {
                // left = well supported, right = no evidence
                val c = 1f - i / (steps - 1f)
                drawRect(evidenceRamp(c), Offset(i * sw, 0f), Size(sw + 1f, size.height))
            }
            val weakStart = size.width * (1f - EvidenceStats.WELL)
            val noneStart = size.width * (1f - EvidenceStats.WEAK)
            hatch(Offset(weakStart, 0f), Size(size.width - weakStart, size.height), Color.White.copy(alpha = 0.8f), 7.dp.toPx(), 1.5.dp.toPx(), rising = true)
            hatch(Offset(noneStart, 0f), Size(size.width - noneStart, size.height), Color.White.copy(alpha = 0.8f), 7.dp.toPx(), 1.5.dp.toPx(), rising = false)
        }
        Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            Hint("Well supported")
            Hint("Weak (hatched)")
            Hint("No evidence (cross-hatched)")
        }
        Row(Modifier.padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            RepairedSwatch(Modifier.size(width = 36.dp, height = 18.dp))
            Spacer(Modifier.width(8.dp))
            Hint("Striped = repaired, synthetic surface (never photographed)")
        }
    }
}

@Composable
internal fun RepairedSwatch(modifier: Modifier = Modifier) {
    Canvas(modifier.clip(RoundedCornerShape(4.dp))) {
        drawRect(RepairedB)
        hatch(Offset.Zero, size, RepairedA, 8.dp.toPx(), 4.dp.toPx(), rising = true)
    }
}

/** Evidence shares as a stacked bar with patterns matching the legend, plus the numbers. */
@Composable
internal fun EvidenceBar(e: EvidenceStats, modifier: Modifier = Modifier) {
    val desc = "Verified surface support: ${formatPercent(e.wellSupported)} well supported, ${formatPercent(e.weak)} weak, " +
        "${formatPercent(e.none)} without evidence, ${formatPercent(e.repaired)} repaired."
    Canvas(modifier.fillMaxWidth().height(18.dp).clip(RoundedCornerShape(5.dp)).semantics { contentDescription = desc }) {
        var x = 0f
        fun seg(fraction: Float, color: Color, pattern: Int) {
            val w = size.width * fraction
            if (w <= 0f) return
            drawRect(color, Offset(x, 0f), Size(w, size.height))
            if (pattern >= 1) hatch(Offset(x, 0f), Size(w, size.height), Color.White.copy(alpha = 0.8f), 7.dp.toPx(), 1.5.dp.toPx(), true)
            if (pattern == 2) hatch(Offset(x, 0f), Size(w, size.height), Color.White.copy(alpha = 0.8f), 7.dp.toPx(), 1.5.dp.toPx(), false)
            if (pattern == 3) hatch(Offset(x, 0f), Size(w, size.height), RepairedA, 8.dp.toPx(), 4.dp.toPx(), true)
            x += w
        }
        seg(e.wellSupported, EvidenceHigh, 0)
        seg(e.weak, EvidenceMid, 1)
        seg(e.none, EvidenceLow, 2)
        seg(e.repaired, RepairedB, 3)
    }
}
