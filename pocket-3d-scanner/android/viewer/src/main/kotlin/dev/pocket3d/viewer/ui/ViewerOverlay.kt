package dev.pocket3d.viewer.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.pocket3d.core.math.Vec3
import dev.pocket3d.viewer.EditTool
import dev.pocket3d.viewer.ToolMode
import dev.pocket3d.viewer.ViewerUiState
import dev.pocket3d.viewer.camera.OrbitCamera
import dev.pocket3d.viewer.scene.CropGizmo

private val MeasureColor = Color(0xFFFFE082)
private val CalibColor = Color(0xFF80DEEA)
private val WarnColor = Color(0xFFFFAB91)
private val HandleColor = Color.White
private val LabelBg = Color(0xD9101418)

/**
 * 2D decorations drawn over the GL view in viewport pixels: measurement lines with their labels,
 * crop handles, the lasso, the magnifier frame and the orientation gizmo. Everything here has a
 * textual counterpart in the tool panels, so nothing depends on this canvas for accessibility.
 */
@Composable
internal fun ViewerOverlay(state: ViewerUiState, camera: OrbitCamera, modifier: Modifier = Modifier) {
    val measurer = rememberTextMeasurer()
    Canvas(modifier.fillMaxSize()) {
        val w = size.width.toInt().coerceAtLeast(1)
        val h = size.height.toInt().coerceAtLeast(1)
        fun project(p: Vec3): Offset? = camera.project(p, w, h)?.let { Offset(it.x, it.y) }

        // measurements
        if (state.tool == ToolMode.Measure || state.tool == ToolMode.View) {
            for (r in state.measure.rows) {
                val a = project(r.a); val b = project(r.b)
                val c = if (r.offSurface) WarnColor else MeasureColor
                if (a != null && b != null) {
                    drawLine(Color.Black.copy(alpha = 0.55f), a, b, strokeWidth = 5.dp.toPx(), cap = StrokeCap.Round)
                    drawLine(c, a, b, strokeWidth = 2.5.dp.toPx(), cap = StrokeCap.Round,
                             pathEffect = if (r.offSurface) PathEffect.dashPathEffect(floatArrayOf(14f, 10f)) else null)
                    val text = if (r.offSurface) "${r.label}  (endpoint no longer on surface)" else r.label
                    label(measurer, "${r.measurement.name}: $text", (a + b) / 2f, c)
                }
                a?.let { endMarker(it, c) }
                b?.let { endMarker(it, c) }
            }
        }
        if (state.tool == ToolMode.Measure) {
            val cal = state.measure.calibration
            if (cal != null) {
                val a = cal.a?.let { project(it.point) }; val b = cal.b?.let { project(it.point) }
                if (a != null && b != null) {
                    drawLine(Color.Black.copy(alpha = 0.55f), a, b, strokeWidth = 5.dp.toPx(), cap = StrokeCap.Round)
                    drawLine(CalibColor, a, b, strokeWidth = 2.5.dp.toPx(), cap = StrokeCap.Round)
                    label(measurer, "Reference distance", (a + b) / 2f, CalibColor)
                }
                a?.let { endMarker(it, CalibColor); label(measurer, "A", it + Offset(0f, -26.dp.toPx()), CalibColor) }
                b?.let { endMarker(it, CalibColor); label(measurer, "B", it + Offset(0f, -26.dp.toPx()), CalibColor) }
            }
            state.measure.pending?.let { p -> project(p.point)?.let { endMarker(it, MeasureColor); label(measurer, "First point", it + Offset(0f, -26.dp.toPx()), MeasureColor) } }
            state.measure.candidate?.let { p -> project(p.point)?.let { endMarker(it, Color.White) } }
        }

        // crop handles
        val crop = state.crop
        if (state.tool == ToolMode.Edit && state.editTool == EditTool.Crop && crop != null) {
            for (f in 0 until CropGizmo.FACE_COUNT) {
                val p = project(CropGizmo.faceCenter(crop.box, f)) ?: continue
                drawCircle(Color.Black.copy(alpha = 0.6f), 13.dp.toPx(), p)
                drawCircle(HandleColor, 10.dp.toPx(), p)
                drawCircle(Color(0xFF14171A), 4.dp.toPx(), p)
            }
            project(crop.box.center)?.let { p ->
                // move handle: a square, so it differs from the round face handles by shape
                val s = 11.dp.toPx()
                drawRoundRect(Color.Black.copy(alpha = 0.6f), p - Offset(s + 3, s + 3), Size(2 * s + 6, 2 * s + 6), CornerRadius(6f))
                drawRoundRect(HandleColor, p - Offset(s, s), Size(2 * s, 2 * s), CornerRadius(5f))
                val k = 6.dp.toPx()
                drawLine(Color(0xFF14171A), p - Offset(k, 0f), p + Offset(k, 0f), strokeWidth = 2.dp.toPx())
                drawLine(Color(0xFF14171A), p - Offset(0f, k), p + Offset(0f, k), strokeWidth = 2.dp.toPx())
            }
        }

        // lasso
        val lasso = state.select.lassoPath
        if (lasso.size >= 4) {
            val path = Path()
            path.moveTo(lasso[0], lasso[1])
            var i = 2
            while (i + 1 < lasso.size) { path.lineTo(lasso[i], lasso[i + 1]); i += 2 }
            path.close()
            drawPath(path, Color(0x33FF9800))
            drawPath(path, Color.Black.copy(alpha = 0.6f), style = Stroke(4.dp.toPx()))
            drawPath(path, Color(0xFFFFB74D), style = Stroke(2.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(12f, 8f))))
        }

        // magnifier frame and crosshair (the magnified image itself is drawn by the GL renderer)
        state.loupe?.let { l ->
            val tl = Offset(l.left.toFloat(), l.top.toFloat())
            val sz = Size(l.sizePx.toFloat(), l.sizePx.toFloat())
            drawRect(Color.Black.copy(alpha = 0.7f), tl, sz, style = Stroke(5.dp.toPx()))
            drawRect(Color.White, tl, sz, style = Stroke(2.dp.toPx()))
            val c = tl + Offset(sz.width / 2f, sz.height / 2f)
            val k = 10.dp.toPx(); val gap = 3.dp.toPx()
            for (dir in listOf(Offset(1f, 0f), Offset(-1f, 0f), Offset(0f, 1f), Offset(0f, -1f))) {
                drawLine(Color.Black, c + dir * gap, c + dir * k, strokeWidth = 3.dp.toPx())
                drawLine(Color.White, c + dir * gap, c + dir * k, strokeWidth = 1.5.dp.toPx())
            }
        }

        if (state.showAxes) axesGizmo(measurer, camera)
    }
}

private fun DrawScope.endMarker(p: Offset, color: Color) {
    drawCircle(Color.Black.copy(alpha = 0.6f), 8.dp.toPx(), p)
    drawCircle(color, 6.dp.toPx(), p)
    drawCircle(Color(0xFF14171A), 2.dp.toPx(), p)
}

private fun DrawScope.label(measurer: TextMeasurer, text: String, at: Offset, color: Color) {
    val layout = measurer.measure(text, TextStyle(color = color, fontSize = 13.sp, fontWeight = FontWeight.Medium), maxLines = 1)
    val pad = 6.dp.toPx()
    val wBox = layout.size.width + 2 * pad
    val hBox = layout.size.height + 2 * pad * 0.6f
    var x = at.x - wBox / 2f
    var y = at.y - hBox - 8.dp.toPx()
    x = x.coerceIn(4f, (size.width - wBox - 4f).coerceAtLeast(4f))
    y = y.coerceIn(4f, (size.height - hBox - 4f).coerceAtLeast(4f))
    drawRoundRect(LabelBg, Offset(x, y), Size(wBox, hBox), CornerRadius(8.dp.toPx()))
    drawText(layout, topLeft = Offset(x + pad, y + pad * 0.6f))
}

/** Small orientation gizmo in the lower-left corner: the three model axes, labelled with letters. */
private fun DrawScope.axesGizmo(measurer: TextMeasurer, camera: OrbitCamera) {
    val r = 26.dp.toPx()
    val c = Offset(r + 22.dp.toPx(), size.height - r - 22.dp.toPx())
    drawCircle(Color(0x66101418), r + 14.dp.toPx(), c)
    val inv = camera.rotation.conjugate()
    data class Axis(val name: String, val dir: Vec3, val color: Color)
    val axes = listOf(Axis("X", inv.rotate(Vec3.X), Color(0xFFFF8A80)), Axis("Y", inv.rotate(Vec3.Y), Color(0xFFB9F6CA)),
                      Axis("Z", inv.rotate(Vec3.Z), Color(0xFF82B1FF))).sortedBy { it.dir.z }
    for (a in axes) {
        val tip = c + Offset(a.dir.x, -a.dir.y) * r
        drawLine(a.color, c, tip, strokeWidth = 2.5.dp.toPx(), cap = StrokeCap.Round)
        val layout = measurer.measure(a.name, TextStyle(color = a.color, fontSize = 11.sp, fontWeight = FontWeight.Bold))
        val off = Offset(a.dir.x, -a.dir.y) * (r + 8.dp.toPx())
        drawText(layout, topLeft = c + off - Offset(layout.size.width / 2f, layout.size.height / 2f))
    }
}
