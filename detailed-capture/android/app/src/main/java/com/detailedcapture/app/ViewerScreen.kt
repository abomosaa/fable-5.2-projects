package com.detailedcapture.app

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ColorMatrixColorFilter
import android.graphics.Matrix
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Redo
import androidx.compose.material.icons.automirrored.filled.RotateLeft
import androidx.compose.material.icons.automirrored.filled.RotateRight
import androidx.compose.material.icons.automirrored.filled.Undo
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.IosShare
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.math.hypot

/** Where the viewer was when the user left it for another screen (restored on return). */
object ViewerMemory {
    var key = ""
    var mode = VMode.View
    var scale = 0f
    var offset = Offset.Zero
}

enum class VMode(val label: String, val edit: Boolean = false) {
    View("View"), Compare("Compare"), Sources("Sources"), Detail("Detail map"), Measure("Measure"),
    Crop("Crop", true), Rotate("Rotate", true), Perspective("Perspective", true), ColorM("Colour", true)
}

data class EditState(
    val rot90: Int = 0, val angle: Float = 0f, val crop: Rect? = null, val persp: List<Offset>? = null,
    val exposure: Float = 0f, val contrast: Float = 0f, val saturation: Float = 0f, val temperature: Float = 0f, val tint: Float = 0f,
) {
    fun toJson(): JSONObject {
        val o = JSONObject().put("rot90", rot90).put("angle", angle.toDouble())
        o.put("crop", crop?.let { JSONObject().put("x", it.left.toDouble()).put("y", it.top.toDouble()).put("w", it.width.toDouble()).put("h", it.height.toDouble()) } ?: JSONObject.NULL)
        o.put("perspective", persp?.let { JSONArray().apply { it.forEach { p -> put(JSONArray().put(p.x.toDouble()).put(p.y.toDouble())) } } } ?: JSONObject.NULL)
        o.put("color", JSONObject().put("exposure", exposure.toDouble()).put("contrast", contrast.toDouble()).put("saturation", saturation.toDouble())
            .put("temperature", temperature.toDouble()).put("tint", tint.toDouble()))
        return o
    }

    companion object {
        fun from(j: JSONObject): EditState {
            val c = j.optJSONObject("crop")
            val pa = j.optJSONArray("perspective")
            val col = j.optJSONObject("color") ?: JSONObject()
            return EditState(
                j.optInt("rot90"), j.optDouble("angle", 0.0).toFloat(),
                c?.let { Rect(it.optDouble("x").toFloat(), it.optDouble("y").toFloat(), (it.optDouble("x") + it.optDouble("w")).toFloat(), (it.optDouble("y") + it.optDouble("h")).toFloat()) },
                pa?.takeIf { it.length() == 4 }?.let { a -> (0 until 4).map { Offset(a.getJSONArray(it).getDouble(0).toFloat(), a.getJSONArray(it).getDouble(1).toFloat()) } },
                col.optDouble("exposure", 0.0).toFloat(), col.optDouble("contrast", 0.0).toFloat(), col.optDouble("saturation", 0.0).toFloat(),
                col.optDouble("temperature", 0.0).toFloat(), col.optDouble("tint", 0.0).toFloat())
        }
    }
}

class Xform(val m: Matrix, val w: Int, val h: Int, val color: ColorMatrixColorFilter?)

/** The core is the single source of truth for the edit geometry and colour maths; the viewer only applies it. */
fun computeXform(e: EditState, baseW: Int, baseH: Int): Xform {
    val r = Core.call("edit.transform", JSONObject().put("edits", e.toJson()).put("width", baseW).put("height", baseH))
    val a = r.getJSONArray("M")
    val m = Matrix().apply { setValues(FloatArray(9) { a.getDouble(it).toFloat() }) }
    val cf = if (r.optBoolean("hasColor")) {
        val c = r.getJSONArray("color")
        fun v(i: Int) = c.getDouble(i).toFloat()
        ColorMatrixColorFilter(floatArrayOf(
            v(0), v(1), v(2), 0f, v(3) * 255f,
            v(4), v(5), v(6), 0f, v(7) * 255f,
            v(8), v(9), v(10), 0f, v(11) * 255f,
            0f, 0f, 0f, 1f, 0f))
    } else null
    return Xform(m, r.getInt("width"), r.getInt("height"), cf)
}

private val labelColors = intArrayOf(0x663DDBB4, 0x66FFB84D, 0x666CB6FF, 0x66FF6B6B, 0x66C792EA, 0x66F4E04D, 0x664DD0E1, 0x66FF8A65, 0x66AED581, 0x66F06292)

fun colorizeLabels(file: File): Bitmap? {
    val src = BitmapFactory.decodeFile(file.absolutePath) ?: return null
    val w = src.width
    val h = src.height
    val px = IntArray(w * h)
    src.getPixels(px, 0, w, 0, 0, w, h)
    for (i in px.indices) {
        val l = px[i] and 0xFF
        px[i] = if (l == 0) 0x00000000 else labelColors[(l - 1) % labelColors.size]
    }
    return Bitmap.createBitmap(px, w, h, Bitmap.Config.ARGB_8888)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ViewerScreen(nav: Nav, dir: File) {
    var tick by remember { mutableIntStateOf(0) }
    val p = rememberProject(dir, tick) ?: run { Box(Modifier.fillMaxSize().background(Palette.bg)); return }
    val res = p.result ?: run { LaunchedEffect(Unit) { nav.pop() }; return }
    val ov = p.overview ?: return
    val scope = rememberCoroutineScope()
    val busy = JobManager.state.collectAsState().value?.projectDir == dir
    val manifest by produceState<JSONObject?>(initialValue = null, res.runId) {
        value = withContext(Dispatchers.IO) { runCatching { Core.call("result.manifest", JSONObject().put("dir", dir.absolutePath)) }.getOrNull() }
    }
    val resultDir = File(dir, "results/${res.runId}")
    val source = remember(res.runId) { DziTileSource(File(resultDir, "tiles"), res.width, res.height) }
    val ovSource = remember(res.runId, manifest?.optString("overviewBase")) {
        val base = manifest?.optString("overviewBase").orEmpty()
        if (base.isNotEmpty() && base != "null") RegionTileSource(File(resultDir, base), 1) else overviewSource(p)
    }
    DisposableEffect(ovSource) { onDispose { ovSource?.close() } }

    val remembered = ViewerMemory.takeIf { it.key == dir.absolutePath + res.runId }
    var mode by remember { mutableStateOf(remembered?.mode ?: VMode.View) }
    // one stable state object (gesture handlers hold on to it); re-synchronised from the project after undo/redo
    val editsState = remember { mutableStateOf(EditState.from(p.edits)) }
    var edits by editsState
    LaunchedEffect(p.j.optJSONArray("undo")?.length(), p.j.optJSONArray("redo")?.length(), res.runId) { edits = EditState.from(p.edits) }
    fun shown(e: EditState) = when (mode) {
        VMode.Crop -> e.copy(crop = null)
        VMode.Perspective -> e.copy(crop = null, persp = null, rot90 = 0, angle = 0f)
        else -> e
    }
    val xf = remember(edits, mode, res.runId) { computeXform(shown(edits), res.width, res.height) }
    // size of the image as it will be exported with ALL edits (the crop/perspective tools show the un-cropped image)
    val outXf = remember(edits, res.runId) { computeXform(edits, res.width, res.height) }
    val vp = remember(res.runId) { ViewportState(xf.w.toFloat(), xf.h.toFloat()) }
    // coming back from another screen (e.g. "original pixels") restores the mode and the view position
    LaunchedEffect(vp.viewSize) {
        if (remembered != null && vp.viewSize.width > 0 && remembered.scale > 0f) {
            vp.scale = remembered.scale; vp.offset = remembered.offset
            ViewerMemory.scale = 0f
        }
    }
    DisposableEffect(res.runId) {
        onDispose { ViewerMemory.key = dir.absolutePath + res.runId; ViewerMemory.mode = if (mode.edit) VMode.View else mode; ViewerMemory.scale = vp.scale; ViewerMemory.offset = vp.offset }
    }
    LaunchedEffect(xf.w, xf.h) {
        if (vp.contentW != xf.w.toFloat() || vp.contentH != xf.h.toFloat()) {
            vp.contentW = xf.w.toFloat(); vp.contentH = xf.h.toFloat(); vp.fit()
        }
    }
    // edit handles sit on the image corners: leave room so they are not under the system gesture edges
    var firstMode by remember { mutableStateOf(true) }
    LaunchedEffect(mode) {
        if (mode == VMode.Crop || mode == VMode.Perspective) vp.fit(0.80f)
        firstMode = false
    }
    fun persist(e: EditState) {
        edits = e
        scope.launch {
            withContext(Dispatchers.IO) { runCatching { Core.call("edits.set", JSONObject().put("dir", dir.absolutePath).put("edits", e.toJson())) } }
            tick++
        }
    }
    fun toBase(content: Offset): Offset {
        val inv = Matrix(); xf.m.invert(inv)
        val pts = floatArrayOf(content.x, content.y); inv.mapPoints(pts)
        return Offset(pts[0], pts[1])
    }
    fun fromBase(base: Offset): Offset {
        val pts = floatArrayOf(base.x, base.y); xf.m.mapPoints(pts)
        return Offset(pts[0], pts[1])
    }

    var split by remember { mutableFloatStateOf(0.5f) }
    var inspect by remember { mutableStateOf<JSONObject?>(null) }
    var sheet by remember { mutableStateOf<String?>(null) }
    val measurePts = remember { mutableStateListOf<Offset>() }  // base output px
    var measureResult by remember { mutableStateOf<JSONObject?>(null) }
    val labelsBmp by produceState<Bitmap?>(initialValue = null, res.runId) { value = withContext(Dispatchers.IO) { colorizeLabels(File(resultDir, "labels.png")) } }
    val detailBmp by produceState<Bitmap?>(initialValue = null, res.runId) { value = withContext(Dispatchers.IO) { colorizeCoverage(File(resultDir, "detail.png")) } }
    val seamScale = manifest?.optInt("seamScale", 1) ?: 1
    val sx = res.width / ov.width.toFloat()
    val sy = res.height / ov.height.toFloat()

    val layers = remember(source, ovSource, xf, mode) {
        buildList {
            add(TileLayer(source, Matrix(xf.m), colorFilter = xf.color))
            if (mode == VMode.Compare && ovSource != null) {
                val m = Matrix().apply { setScale(res.width / ovSource.width.toFloat(), res.height / ovSource.height.toFloat()); postConcat(xf.m) }
                add(TileLayer(ovSource, m, clipFraction = { split }, colorFilter = xf.color))
            }
        }
    }

    // Gesture handlers are created once per mode/geometry and always read the CURRENT edit state when a drag
    // starts (a handler that is re-created while a drag is in progress loses the drag).
    val dragHandler = remember(mode, xf.w, xf.h) {
        when (mode) {
            VMode.Crop -> object : DragHandler {
                var corner = -1
                var last = Offset.Zero
                var cur = Rect(0f, 0f, 1f, 1f)
                override fun onDown(content: Offset, screenSlop: Float): Boolean {
                    cur = editsState.value.crop ?: Rect(0f, 0f, 1f, 1f)
                    val n = Offset(content.x / xf.w, content.y / xf.h)
                    val cs = listOf(cur.topLeft, cur.topRight, cur.bottomRight, cur.bottomLeft)
                    val d = cs.map { hypot((it.x - n.x) * xf.w, (it.y - n.y) * xf.h) }
                    val i = d.indices.minBy { d[it] }
                    corner = if (d[i] < screenSlop * 2.2f) i else if (cur.contains(n)) 4 else -1
                    last = n
                    return corner >= 0
                }
                override fun onMove(content: Offset) {
                    if (corner < 0) return
                    val n = Offset((content.x / xf.w).coerceIn(0f, 1f), (content.y / xf.h).coerceIn(0f, 1f))
                    val minS = 0.05f
                    cur = when (corner) {
                        0 -> Rect(n.x.coerceAtMost(cur.right - minS), n.y.coerceAtMost(cur.bottom - minS), cur.right, cur.bottom)
                        1 -> Rect(cur.left, n.y.coerceAtMost(cur.bottom - minS), n.x.coerceAtLeast(cur.left + minS), cur.bottom)
                        2 -> Rect(cur.left, cur.top, n.x.coerceAtLeast(cur.left + minS), n.y.coerceAtLeast(cur.top + minS))
                        3 -> Rect(n.x.coerceAtMost(cur.right - minS), cur.top, cur.right, n.y.coerceAtLeast(cur.top + minS))
                        else -> {
                            val dx = (n.x - last.x).coerceIn(-cur.left, 1f - cur.right)
                            val dy = (n.y - last.y).coerceIn(-cur.top, 1f - cur.bottom)
                            cur.translate(dx, dy)
                        }
                    }
                    last = n
                    editsState.value = editsState.value.copy(crop = cur)
                }
                override fun onUp() { if (corner >= 0) persist(editsState.value); corner = -1 }
            }
            VMode.Perspective -> object : DragHandler {
                var idx = -1
                var pts = mutableListOf<Offset>()
                override fun onDown(content: Offset, screenSlop: Float): Boolean {
                    pts = (editsState.value.persp ?: listOf(Offset(0f, 0f), Offset(1f, 0f), Offset(1f, 1f), Offset(0f, 1f))).toMutableList()
                    val d = pts.map { hypot(it.x * xf.w - content.x, it.y * xf.h - content.y) }
                    val i = d.indices.minBy { d[it] }
                    idx = if (d[i] < screenSlop * 2.2f) i else -1
                    return idx >= 0
                }
                override fun onMove(content: Offset) {
                    if (idx < 0) return
                    pts[idx] = Offset((content.x / xf.w).coerceIn(0f, 1f), (content.y / xf.h).coerceIn(0f, 1f))
                    editsState.value = editsState.value.copy(persp = pts.toList())
                }
                override fun onUp() {
                    if (idx >= 0) { if (isConvex(pts)) persist(editsState.value) else editsState.value = EditState.from(p.edits) }
                    idx = -1
                }
            }
            else -> null
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("${outXf.w} × ${outXf.h} px", fontWeight = FontWeight.SemiBold, fontSize = 17.sp, modifier = Modifier.testTag("viewer_dims"))
                        Text("≈ ${fmtMP(res.stats.optDouble("estimatedDetailMP", 0.0))} real detail · ${fmtGain(res.scale)} grid", fontSize = 12.sp, color = Palette.dim, maxLines = 1)
                    }
                },
                navigationIcon = { IconButton(onClick = { nav.pop() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = {
                    IconButton(enabled = p.canUndo, onClick = { scope.launch { withContext(Dispatchers.IO) { Core.call("undo", JSONObject().put("dir", dir.absolutePath)) }; tick++ } }, modifier = Modifier.testTag("btn_undo")) { Icon(Icons.AutoMirrored.Filled.Undo, "Undo") }
                    IconButton(enabled = p.canRedo, onClick = { scope.launch { withContext(Dispatchers.IO) { Core.call("redo", JSONObject().put("dir", dir.absolutePath)) }; tick++ } }, modifier = Modifier.testTag("btn_redo")) { Icon(Icons.AutoMirrored.Filled.Redo, "Redo") }
                    IconButton(onClick = { sheet = "info" }, modifier = Modifier.testTag("btn_info")) { Icon(Icons.Default.Info, "Result details") }
                    IconButton(onClick = { sheet = "export" }, modifier = Modifier.testTag("btn_export")) { Icon(Icons.Default.IosShare, "Export") }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.bg),
            )
        },
        containerColor = Palette.bg,
    ) { pad ->
        Column(Modifier.fillMaxSize().padding(pad)) {
            Box(Modifier.weight(1f).fillMaxWidth().background(Color.Black)) {
                TileViewer(
                    vp, layers, Modifier.testTag("viewer"), dragHandler = dragHandler,
                    onTap = when (mode) {
                        VMode.Sources -> { c ->
                            val b = toBase(c)
                            scope.launch {
                                inspect = withContext(Dispatchers.IO) { runCatching { Core.call("inspect.point", JSONObject().put("dir", dir.absolutePath).put("x", b.x.toDouble()).put("y", b.y.toDouble())) }.getOrNull() }
                            }
                        }
                        VMode.Measure -> { c ->
                            if (measurePts.size >= 2) measurePts.clear()
                            measurePts.add(toBase(c))
                            if (measurePts.size == 2) scope.launch {
                                measureResult = withContext(Dispatchers.IO) {
                                    runCatching {
                                        Core.call("measure", JSONObject().put("dir", dir.absolutePath).put("x1", (measurePts[0].x / sx).toDouble()).put("y1", (measurePts[0].y / sy).toDouble())
                                            .put("x2", (measurePts[1].x / sx).toDouble()).put("y2", (measurePts[1].y / sy).toDouble()))
                                    }.getOrNull()
                                }
                            } else measureResult = null
                        }
                        else -> null
                    },
                    overlay = { v ->
                        fun drawRaster(b: Bitmap, q: Float) = drawIntoCanvas { c ->
                            val nc = c.nativeCanvas
                            nc.save()
                            nc.translate(v.offset.x, v.offset.y); nc.scale(v.scale, v.scale); nc.concat(xf.m); nc.scale(q, q)
                            nc.drawBitmap(b, 0f, 0f, android.graphics.Paint().apply { isFilterBitmap = false })
                            nc.restore()
                        }
                        when (mode) {
                            VMode.Sources -> labelsBmp?.let { drawRaster(it, seamScale.toFloat()) }
                            VMode.Detail -> detailBmp?.let { drawRaster(it, seamScale.toFloat()) }
                            VMode.Compare -> {
                                val x = size.width * split
                                drawLine(Color.White, Offset(x, 0f), Offset(x, size.height), 3f)
                            }
                            VMode.Crop -> {
                                val cr = edits.crop ?: Rect(0f, 0f, 1f, 1f)
                                val a = v.toScreen(Offset(cr.left * xf.w, cr.top * xf.h))
                                val b = v.toScreen(Offset(cr.right * xf.w, cr.bottom * xf.h))
                                val dim = Color.Black.copy(alpha = 0.55f)
                                drawRect(dim, Offset.Zero, Size(size.width, a.y)); drawRect(dim, Offset(0f, b.y), Size(size.width, size.height - b.y))
                                drawRect(dim, Offset(0f, a.y), Size(a.x, b.y - a.y)); drawRect(dim, Offset(b.x, a.y), Size(size.width - b.x, b.y - a.y))
                                drawRect(Color.White, a, Size(b.x - a.x, b.y - a.y), style = Stroke(3f))
                                for (i in 1..2) {
                                    drawLine(Color.White.copy(alpha = 0.4f), Offset(a.x + (b.x - a.x) * i / 3, a.y), Offset(a.x + (b.x - a.x) * i / 3, b.y), 1.5f)
                                    drawLine(Color.White.copy(alpha = 0.4f), Offset(a.x, a.y + (b.y - a.y) * i / 3), Offset(b.x, a.y + (b.y - a.y) * i / 3), 1.5f)
                                }
                                listOf(a, Offset(b.x, a.y), b, Offset(a.x, b.y)).forEach { drawCircle(Color.White, 16f, it); drawCircle(Palette.teal, 11f, it) }
                            }
                            VMode.Perspective -> {
                                val pts = (edits.persp ?: listOf(Offset(0f, 0f), Offset(1f, 0f), Offset(1f, 1f), Offset(0f, 1f))).map { v.toScreen(Offset(it.x * xf.w, it.y * xf.h)) }
                                val path = Path().apply { moveTo(pts[0].x, pts[0].y); pts.drop(1).forEach { lineTo(it.x, it.y) }; close() }
                                drawPath(path, Palette.amber.copy(alpha = 0.10f)); drawPath(path, Palette.amber, style = Stroke(3f))
                                pts.forEach { drawCircle(Color.White, 16f, it); drawCircle(Palette.amber, 11f, it) }
                            }
                            VMode.Measure -> {
                                val sp = measurePts.map { v.toScreen(fromBase(it)) }
                                if (sp.size == 2) drawLine(Palette.amber, sp[0], sp[1], 4f)
                                sp.forEachIndexed { i, o -> drawMarker(o, if (i == 0) "A" else "B", Palette.amber) }
                                p.calibration?.let { c ->
                                    val a = v.toScreen(fromBase(Offset(c.optDouble("x1").toFloat() * sx, c.optDouble("y1").toFloat() * sy)))
                                    val b = v.toScreen(fromBase(Offset(c.optDouble("x2").toFloat() * sx, c.optDouble("y2").toFloat() * sy)))
                                    drawLine(Palette.teal, a, b, 3f)
                                }
                            }
                            else -> {}
                        }
                    },
                )
                Text("${"%.0f".format(vp.scale * 100)}% of output pixels", Modifier.align(Alignment.TopEnd).padding(10.dp).clip(RoundedCornerShape(8.dp)).background(Color.Black.copy(alpha = 0.6f)).padding(horizontal = 8.dp, vertical = 4.dp),
                    fontSize = 12.sp, color = Color.White)
                if (mode == VMode.Compare) {
                    Text("Overview, enlarged", Modifier.align(Alignment.TopStart).padding(10.dp).clip(RoundedCornerShape(8.dp)).background(Color.Black.copy(alpha = 0.6f)).padding(horizontal = 8.dp, vertical = 4.dp), fontSize = 12.sp, color = Color.White)
                    Text("Fused", Modifier.align(Alignment.BottomEnd).padding(10.dp).clip(RoundedCornerShape(8.dp)).background(Color.Black.copy(alpha = 0.6f)).padding(horizontal = 8.dp, vertical = 4.dp), fontSize = 12.sp, color = Color.White)
                }
            }
            Column(Modifier.fillMaxWidth().background(Palette.surface).navigationBarsPadding()) {
                if (busy) JobBanner(dir, Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
                else if (res.stale) Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Changes are waiting: fuse again to update this result.", Modifier.weight(1f), fontSize = 13.sp, color = Palette.amber)
                    TextButton(onClick = { JobManager.compose(dir) }, modifier = Modifier.testTag("btn_refuse")) { Text("Fuse again") }
                }
                // per-mode controls
                Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
                    when (mode) {
                        VMode.View -> Text("Pinch to zoom, double-tap to zoom in. Above 300% pixels are shown unsmoothed.", fontSize = 12.sp, color = Palette.dim, modifier = Modifier.padding(top = 10.dp))
                        VMode.Compare -> Column {
                            Text("Left of the line: the overview enlarged to the same size. Right: the fused result. Same scene coordinates, no sharpening.", fontSize = 12.sp, color = Palette.dim, modifier = Modifier.padding(top = 10.dp))
                            Slider(split, { split = it }, modifier = Modifier.testTag("compare_slider"))
                        }
                        VMode.Sources -> Text("Each tint is one close-up photograph. Untinted areas are the enlarged overview (no added detail). Tap anywhere to see and inspect the source.",
                            fontSize = 12.sp, color = Palette.dim, modifier = Modifier.padding(top = 10.dp))
                        VMode.Detail -> Text("Green intensity = estimated genuine detail from close-ups (≥1.5×, ≥2×, ≥3×, ≥4× the overview). No tint = overview only.",
                            fontSize = 12.sp, color = Palette.dim, modifier = Modifier.padding(top = 10.dp))
                        VMode.Measure -> Column(Modifier.padding(top = 10.dp)) {
                            val mr = measureResult
                            val txt = when {
                                measurePts.size < 2 -> "Tap two points. Distances are in pixels unless you set a reference length."
                                mr == null -> "…"
                                mr.optBoolean("calibrated") -> "A–B ≈ %.2f ± %.2f %s (1σ) · %.1f overview px".format(mr.optDouble("value"), mr.optDouble("sigma"), mr.optString("unit"), mr.optDouble("canvasPx"))
                                else -> "A–B = %.1f overview px (%.1f output px). No real-world unit: set a reference first.".format(mr.optDouble("canvasPx"), mr.optDouble("canvasPx") * res.scale)
                            }
                            Text(txt, fontSize = 14.sp, modifier = Modifier.testTag("measure_text"))
                            Text(mr?.optString("note") ?: "Visual detail is not certified measurement accuracy.", fontSize = 11.sp, color = Palette.dim, lineHeight = 15.sp)
                            Row {
                                TextButton(enabled = measurePts.size == 2, onClick = { sheet = "reference" }) { Text("Set A–B as reference length") }
                                if (p.calibration != null) TextButton(onClick = {
                                    scope.launch { withContext(Dispatchers.IO) { Core.call("edits.set", JSONObject().put("dir", dir.absolutePath).put("calibration", JSONObject.NULL)) }; measureResult = null; measurePts.clear(); tick++ }
                                }) { Text("Clear reference") }
                            }
                        }
                        VMode.Crop -> Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("Drag the corners. Cropping never changes pixels.", Modifier.weight(1f), fontSize = 12.sp, color = Palette.dim)
                            TextButton(enabled = edits.crop != null, onClick = { persist(edits.copy(crop = null)) }) { Text("Reset") }
                        }
                        VMode.Rotate -> Column {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                IconButton(onClick = { persist(edits.copy(rot90 = (edits.rot90 + 3) % 4, crop = null)) }) { Icon(Icons.AutoMirrored.Filled.RotateLeft, "Rotate left") }
                                IconButton(onClick = { persist(edits.copy(rot90 = (edits.rot90 + 1) % 4, crop = null)) }, modifier = Modifier.testTag("btn_rot90")) { Icon(Icons.AutoMirrored.Filled.RotateRight, "Rotate right") }
                                Text("Straighten %.1f°".format(edits.angle), Modifier.weight(1f).padding(start = 8.dp), fontSize = 13.sp)
                                TextButton(enabled = edits.angle != 0f || edits.rot90 != 0, onClick = { persist(edits.copy(angle = 0f, rot90 = 0)) }) { Text("Reset") }
                            }
                            Slider(edits.angle, { edits = edits.copy(angle = Math.round(it * 10) / 10f) }, valueRange = -20f..20f, onValueChangeFinished = { persist(edits) })
                            Text("90° turns are exact. Straightening resamples once at export (Lanczos).", fontSize = 11.sp, color = Palette.dim)
                        }
                        VMode.Perspective -> Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("Drag the four corners onto the subject's corners; it is rectified to a rectangle at export.", Modifier.weight(1f), fontSize = 12.sp, color = Palette.dim)
                            TextButton(enabled = edits.persp != null, onClick = { persist(edits.copy(persp = null)) }) { Text("Reset") }
                        }
                        VMode.ColorM -> Column(Modifier.heightIn(max = 250.dp).verticalScroll(rememberScrollState())) {
                            @Composable fun S(label: String, v: Float, range: ClosedFloatingPointRange<Float>, set: (Float) -> EditState) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(label, Modifier.width(96.dp), fontSize = 13.sp)
                                    Slider(v, { edits = set(Math.round(it * 100) / 100f) }, valueRange = range, onValueChangeFinished = { persist(edits) }, modifier = Modifier.weight(1f))
                                    Text("%+.2f".format(v), Modifier.width(48.dp), fontSize = 12.sp, color = Palette.dim)
                                }
                            }
                            S("Exposure", edits.exposure, -2f..2f) { edits.copy(exposure = it) }
                            S("Contrast", edits.contrast, -1f..1f) { edits.copy(contrast = it) }
                            S("Saturation", edits.saturation, -1f..1f) { edits.copy(saturation = it) }
                            S("Warmth", edits.temperature, -1f..1f) { edits.copy(temperature = it) }
                            S("Tint", edits.tint, -1f..1f) { edits.copy(tint = it) }
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text("Reversible display/export adjustment; the fused pixels are untouched.", Modifier.weight(1f), fontSize = 11.sp, color = Palette.dim)
                                TextButton(onClick = { persist(edits.copy(exposure = 0f, contrast = 0f, saturation = 0f, temperature = 0f, tint = 0f)) }) { Text("Reset") }
                            }
                        }
                    }
                }
                LazyRow(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentPadding = PaddingValues(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(VMode.entries.toList()) { m ->
                        FilterChip(selected = mode == m, onClick = { mode = m; inspect = null }, label = { Text(m.label) }, modifier = Modifier.testTag("mode_${m.name}"))
                    }
                }
            }
        }
    }

    // ---- source inspection sheet -----------------------------------------------------------------
    inspect?.let { ins ->
        ModalBottomSheet(onDismissRequest = { inspect = null }, containerColor = Palette.surface) {
            Column(Modifier.tagRoot().padding(horizontal = 20.dp).padding(bottom = 20.dp).navigationBarsPadding()) {
                val srcO = ins.optJSONObject("source")
                if (ins.optBoolean("isOverviewOnly")) {
                    Text("Overview only", fontWeight = FontWeight.SemiBold, fontSize = 18.sp, modifier = Modifier.testTag("inspect_title"))
                    Text("This spot shows the enlarged overview. No verified close-up contributes here, so there is no added detail.", fontSize = 14.sp, color = Palette.dim, modifier = Modifier.padding(top = 6.dp))
                } else if (srcO != null) {
                    Text("From ${p.labelOf(srcO.optString("id"))}", fontWeight = FontWeight.SemiBold, fontSize = 18.sp, modifier = Modifier.testTag("inspect_title"))
                    Text("Sampled at ${fmtGain(srcO.optDouble("scale"))} the overview · source pixel (${srcO.optDouble("fx").toInt()}, ${srcO.optDouble("fy").toInt()})", fontSize = 14.sp, color = Palette.dim, modifier = Modifier.padding(top = 6.dp))
                    OutlinedButton(onClick = { inspect = null; nav.push(Screen.FrameS(dir, srcO.optString("id"), srcO.optDouble("fx").toFloat(), srcO.optDouble("fy").toFloat())) },
                        Modifier.padding(top = 10.dp).testTag("btn_view_source")) { Text("View the original pixels at 100%") }
                }
                val canvas = ins.optJSONArray("canvas")
                val cands = ins.optJSONArray("candidates").objects().filter { !it.optBoolean("used") }
                if (cands.isNotEmpty() && canvas != null) {
                    SectionLabel("Use a different source here")
                    cands.forEach { c ->
                        val isOv = c.optInt("label") == 0
                        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable {
                            val arr = JSONArray(p.edits.optJSONArray("overrides")?.toString() ?: "[]")
                            arr.put(JSONObject().put("x", canvas.getDouble(0)).put("y", canvas.getDouble(1)).put("r", ov.width * 0.035).put("frame", if (isOv) "overview" else c.optString("id")).put("mode", "prefer"))
                            scope.launch {
                                withContext(Dispatchers.IO) { Core.call("edits.set", JSONObject().put("dir", dir.absolutePath).put("edits", JSONObject().put("overrides", arr))) }
                                inspect = null; tick++
                            }
                        }.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(if (isOv) "Overview (lower detail)" else "${p.labelOf(c.optString("id"))} · ${fmtGain(c.optDouble("scale"))}", Modifier.weight(1f), fontSize = 14.sp)
                            Text("Use here", color = Palette.teal, fontSize = 13.sp)
                        }
                    }
                    Text("Overrides take effect when you fuse again; only the affected tiles are re-rendered. Undo restores the previous choice.", fontSize = 12.sp, color = Palette.dim, lineHeight = 16.sp)
                }
                if ((p.edits.optJSONArray("overrides")?.length() ?: 0) > 0) TextButton(onClick = {
                    scope.launch { withContext(Dispatchers.IO) { Core.call("edits.set", JSONObject().put("dir", dir.absolutePath).put("edits", JSONObject().put("overrides", JSONArray()))) }; inspect = null; tick++ }
                }) { Text("Remove all source overrides (${p.edits.optJSONArray("overrides")?.length()})") }
            }
        }
    }

    when (sheet) {
        "info" -> AlertDialog(onDismissRequest = { sheet = null }, confirmButton = { TextButton(onClick = { sheet = null }) { Text("Close") } }, title = { Text("Result details") }, text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                val s = res.stats
                val h = s.optJSONObject("detailHistogram") ?: JSONObject()
                @Composable fun R(k: String, v: String) = Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) { Text(k, Modifier.weight(1f), fontSize = 13.sp, color = Palette.dim); Text(v, fontSize = 13.sp) }
                R("Output grid", "${res.width} × ${res.height} (${fmtMP(s.optDouble("outputMP"))})")
                R("Overview", "${ov.width} × ${ov.height} (${fmtMP(s.optDouble("overviewMP"))})")
                R("Estimated genuine detail", "≈ ${fmtMP(s.optDouble("estimatedDetailMP"))}")
                R("Area from close-ups", "${(s.optDouble("closeupAreaFrac") * 100).toInt()}%")
                R("Result area at ≥1.5× / ≥2× / ≥3× / ≥4× (after seam selection)", listOf("ge1.5", "ge2.0", "ge3.0", "ge4.0").joinToString(" / ") { "${(h.optDouble(it, 0.0) * 100).toInt()}%" })
                R("Close-ups used", "${s.optInt("framesUsed")}")
                R("Colour / depth", "${manifest?.optString("colorSpace") ?: "sRGB"} · 8-bit")
                R("Fusion time", "%.1f s (%d tiles reused)".format(s.optDouble("ms") / 1000.0, s.optInt("blocksReused")))
                val warns = manifest?.optJSONArray("warnings").objects()
                if (warns.isNotEmpty()) Text("${warns.size} close-up(s) needed a strong exposure/colour correction to match the overview.", fontSize = 12.sp, color = Palette.amber, modifier = Modifier.padding(top = 6.dp))
                Text("The pixel count of the grid is not a measure of detail. The estimate above comes from how densely the accepted close-ups sample the subject and how sharp they measured. Areas without verified close-ups show the enlarged overview. Nothing is generated or sharpened.",
                    fontSize = 12.sp, color = Palette.dim, lineHeight = 16.sp, modifier = Modifier.padding(top = 10.dp))
            }
        })
        "export" -> ModalBottomSheet(onDismissRequest = { sheet = null }, containerColor = Palette.surface) {
            Column(Modifier.tagRoot().navigationBarsPadding().padding(bottom = 12.dp)) {
                Text("Export ${outXf.w} × ${outXf.h} px", Modifier.padding(horizontal = 24.dp, vertical = 8.dp), fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                val jpegOk = outXf.w <= 65535 && outXf.h <= 65535
                val huge = outXf.w.toLong() * outXf.h > 250_000_000L
                Text("All exports are 8-bit in the overview's colour space and include your crop, rotation and colour edits. Nothing is down-scaled." +
                    if (huge) " This image exceeds 250 MP: many apps cannot open a flat file this large — the tile package always works." else "",
                    Modifier.padding(horizontal = 24.dp).padding(bottom = 6.dp), fontSize = 12.sp, color = Palette.dim, lineHeight = 16.sp)
                SheetItem(Icons.Default.IosShare, "PNG — lossless", "Streamed to disk, any size") { sheet = "exporting"; Exports.flat(p, "png") }
                SheetItem(Icons.Default.IosShare, "TIFF — lossless (deflate)", "BigTIFF automatically above 4 GB") { sheet = "exporting"; Exports.flat(p, "tiff") }
                SheetItem(Icons.Default.IosShare, "JPEG — quality 95", if (jpegOk) "Smaller, lossy, 4:4:4" else "Not available: JPEG is limited to 65,535 px per side") { if (jpegOk) { sheet = "exporting"; Exports.flat(p, "jpeg") } }
                SheetItem(Icons.Default.IosShare, "Tile package (.zip)", "Deep Zoom pyramid + offline viewer.html; for very large results") { sheet = "exporting"; Exports.tilePackage(p, "png") }
                SheetItem(Icons.Default.IosShare, "Project archive (.dcap.zip)", "Original photos, transforms, edits and this result") { sheet = "exporting"; Exports.archive(p, includeResult = true) }
            }
        }
        "exporting" -> ExportResultDialog(dir) { sheet = null }
        "reference" -> {
            var len by remember { mutableStateOf("") }
            var unit by remember { mutableStateOf("mm") }
            var unc by remember { mutableStateOf("0.5") }
            AlertDialog(onDismissRequest = { sheet = null }, title = { Text("Reference length") }, text = {
                Column {
                    Text("Enter the real length of A–B, measured on the subject with a ruler. Other measurements on the same flat plane are then estimated from it.", fontSize = 13.sp, color = Palette.dim)
                    OutlinedTextField(len, { len = it }, label = { Text("Length") }, singleLine = true, modifier = Modifier.padding(top = 8.dp))
                    OutlinedTextField(unit, { unit = it }, label = { Text("Unit") }, singleLine = true, modifier = Modifier.padding(top = 8.dp))
                    OutlinedTextField(unc, { unc = it }, label = { Text("Uncertainty of that length (± same unit)") }, singleLine = true, modifier = Modifier.padding(top = 8.dp))
                }
            }, confirmButton = {
                TextButton(enabled = (len.toDoubleOrNull() ?: 0.0) > 0 && measurePts.size == 2, onClick = {
                    val cal = JSONObject().put("x1", (measurePts[0].x / sx).toDouble()).put("y1", (measurePts[0].y / sy).toDouble()).put("x2", (measurePts[1].x / sx).toDouble()).put("y2", (measurePts[1].y / sy).toDouble())
                        .put("length", len.toDouble()).put("unit", unit.ifBlank { "units" }).put("lengthSigma", unc.toDoubleOrNull() ?: 0.0).put("endpointSigmaPx", 1.5)
                    sheet = null
                    scope.launch { withContext(Dispatchers.IO) { Core.call("edits.set", JSONObject().put("dir", dir.absolutePath).put("calibration", cal)) }; measurePts.clear(); measureResult = null; tick++ }
                }) { Text("Save") }
            }, dismissButton = { TextButton(onClick = { sheet = null }) { Text("Cancel") } })
        }
    }
}

fun isConvex(p: List<Offset>): Boolean {
    var sign = 0f
    for (i in 0 until 4) {
        val a = p[i]; val b = p[(i + 1) % 4]; val c = p[(i + 2) % 4]
        val cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
        if (cr == 0f) return false
        if (sign == 0f) sign = cr else if (sign * cr < 0) return false
    }
    return sign > 0
}
