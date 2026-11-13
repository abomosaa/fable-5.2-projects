package com.detailedcapture.app

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Undo
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
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

fun frameSource(p: Project, f: Frame): RegionTileSource = RegionTileSource(p.file(f.working ?: f.file), if (f.working != null) 1 else f.orientation)

fun DrawScope.drawMarker(at: Offset, label: String?, color: Color) {
    drawCircle(Color.Black.copy(alpha = 0.6f), 15f, at)
    drawCircle(color, 13f, at, style = Stroke(3.5f))
    drawLine(color, Offset(at.x - 7f, at.y), Offset(at.x + 7f, at.y), 2.5f)
    drawLine(color, Offset(at.x, at.y - 7f), Offset(at.x, at.y + 7f), 2.5f)
    if (label != null) drawIntoCanvas {
        val paint = android.graphics.Paint().apply { this.color = android.graphics.Color.WHITE; textSize = 30f; isAntiAlias = true; setShadowLayer(4f, 0f, 0f, android.graphics.Color.BLACK); isFakeBoldText = true }
        it.nativeCanvas.drawText(label, at.x + 18f, at.y - 14f, paint)
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun FrameScreen(nav: Nav, s: Screen.FrameS) {
    var tick by remember { mutableIntStateOf(0) }
    val p = rememberProject(s.dir, tick) ?: run { Box(Modifier.fillMaxSize().background(Palette.bg)); return }
    val f = p.frame(s.id) ?: run { LaunchedEffect(Unit) { nav.pop() }; return }
    val scope = rememberCoroutineScope()
    val source = remember(f.id) { frameSource(p, f) }
    DisposableEffect(source) { onDispose { source.close() } }
    val vp = remember(f.id) { ViewportState(f.width.toFloat(), f.height.toFloat()) }
    LaunchedEffect(vp.viewSize, s.fx) {
        if (s.fx != null && s.fy != null && vp.viewSize.width > 0) vp.centerOn(Offset(s.fx, s.fy), 1f)  // 100 %: one source pixel per screen pixel
    }
    fun update(user: JSONObject, thenPop: Boolean = false) {
        scope.launch {
            withContext(Dispatchers.IO) { runCatching { Core.call("frame.update", JSONObject().put("dir", s.dir.absolutePath).put("id", f.id).put("user", user)) } }
            JobManager.register(s.dir)
            if (thenPop) nav.pop() else tick++
        }
    }
    val st = f.displayStatus
    var confirmRemove by remember { mutableStateOf(false) }
    if (confirmRemove) androidx.compose.material3.AlertDialog(
        onDismissRequest = { confirmRemove = false },
        title = { Text("Remove this photo?") },
        text = { Text("It is taken out of the project and no longer used. The file is kept until the project is deleted, and Undo on the project screen brings it back.") },
        confirmButton = { TextButton(onClick = { confirmRemove = false; update(JSONObject().put("removed", true), thenPop = true) }, modifier = Modifier.testTag("btn_remove_confirm")) { Text("Remove") } },
        dismissButton = { TextButton(onClick = { confirmRemove = false }) { Text("Cancel") } })
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(p.labelOf(f.id).substringBefore(" ("), fontWeight = FontWeight.SemiBold)
                        Text("Original pixels · ${f.width} × ${f.height}" + (if (f.originalName.isNotEmpty()) " · ${f.originalName}" else ""), fontSize = 12.sp, color = Palette.dim, maxLines = 1)
                    }
                },
                navigationIcon = { IconButton(onClick = { nav.pop() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = {
                    if (f.role == "closeup") IconButton(onClick = { confirmRemove = true }, modifier = Modifier.testTag("btn_remove")) { Icon(Icons.Default.Delete, "Remove from project") }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.bg),
            )
        },
        containerColor = Palette.bg,
    ) { pad ->
        Column(Modifier.fillMaxSize().padding(pad)) {
            Box(Modifier.weight(1f).fillMaxWidth().background(Color.Black)) {
                TileViewer(vp, listOf(TileLayer(source)), overlay = { v ->
                    // regions masked as inconsistent with a flat, static subject
                    val bits = f.reg.optString("maskBits")
                    val mw = f.reg.optInt("maskW")
                    val mh = f.reg.optInt("maskH")
                    if (bits.length == mw * mh && mw > 0) {
                        val cw = f.width / mw.toFloat()
                        val ch = f.height / mh.toFloat()
                        for (i in bits.indices) if (bits[i] == '1') {
                            val a = v.toScreen(Offset((i % mw) * cw, (i / mw) * ch))
                            drawRect(Palette.red.copy(alpha = 0.32f), a, Size(cw * v.scale, ch * v.scale))
                        }
                    }
                    if (s.fx != null && s.fy != null) drawMarker(v.toScreen(Offset(s.fx, s.fy)), null, Palette.teal)
                })
                Text("${(vp.scale * 100).toInt()}% of source pixels", Modifier.align(Alignment.TopEnd).padding(10.dp).clip(RoundedCornerShape(8.dp)).background(Color.Black.copy(alpha = 0.6f)).padding(horizontal = 8.dp, vertical = 4.dp),
                    fontSize = 12.sp, color = Color.White)
            }
            Column(Modifier.fillMaxWidth().heightIn(max = 330.dp).background(Palette.surface).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp).navigationBarsPadding()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Pill(statusLabel(st), Palette.status(st), Modifier.testTag("frame_status"))
                    Spacer(Modifier.width(8.dp))
                    if (f.role == "closeup" && f.scale > 0) Text("${fmtGain(f.scale)} closer than the overview · ≈${fmtGain(f.effGain)} effective detail", fontSize = 13.sp, color = Palette.dim)
                }
                val msgs = f.messages
                if (st == "unprocessed") Text("Waiting to be checked against the overview.", fontSize = 14.sp, modifier = Modifier.padding(top = 8.dp))
                if (st == "accepted" && msgs.isEmpty()) Text("Aligned, verified against the overview and adding detail.", fontSize = 14.sp, modifier = Modifier.padding(top = 8.dp))
                if (st == "excluded") Text("You excluded this photo. It is kept in the project and can be included again.", fontSize = 14.sp, modifier = Modifier.padding(top = 8.dp))
                msgs.forEach { Text("• $it", fontSize = 14.sp, lineHeight = 20.sp, modifier = Modifier.padding(top = 8.dp)) }
                if (f.role == "closeup") {
                    FlowRow(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (f.included) OutlinedButton(onClick = { update(JSONObject().put("included", false)) }, modifier = Modifier.testTag("btn_exclude")) { Text("Exclude") }
                        else FilledTonalButton(onClick = { update(JSONObject().put("included", true)) }, modifier = Modifier.testTag("btn_include")) { Text("Include again") }
                        if (f.status == "uncertain" && f.reg.has("H") && !f.user.optBoolean("forceAccept"))
                            OutlinedButton(onClick = { update(JSONObject().put("forceAccept", true)) }) { Icon(Icons.Default.Check, null); Spacer(Modifier.width(4.dp)); Text("Use anyway") }
                        if (f.user.optBoolean("forceAccept")) OutlinedButton(onClick = { update(JSONObject().put("forceAccept", false)) }) { Icon(Icons.AutoMirrored.Filled.Undo, null); Spacer(Modifier.width(4.dp)); Text("Stop forcing") }
                        FilledTonalButton(onClick = { nav.push(Screen.Manual(s.dir, f.id)) }, modifier = Modifier.testTag("btn_manual")) { Text(if (f.manualPoints.length() >= 4) "Edit reference points" else "Place manually") }
                    }
                }
                SectionLabel("Checks")
                val r = f.reg
                val q = f.quality
                val rows = buildList {
                    if (f.role == "closeup") {
                        add("Reliable matches" to "${r.optInt("nInliers")} (${r.optString("via", "—")})")
                        if (r.has("zncc") && r.optDouble("zncc", -1.0) >= 0) add("Similarity to overview" to "%.2f".format(r.optDouble("zncc")))
                        if (r.has("pairs")) add("Consistent neighbours" to "${r.optInt("pairs")}" + (if (r.optInt("conflicts") > 0) " (${r.optInt("conflicts")} conflicting)" else ""))
                        if (r.optDouble("residualPx", 0.0) > 0) add("Alignment residual" to "%.2f px".format(r.optDouble("residualPx")))
                        if (r.optDouble("maskedFrac", 0.0) > 0) add("Masked area" to "${(r.optDouble("maskedFrac") * 100).toInt()}%")
                        if (kotlin.math.abs(r.optDouble("k1", 0.0)) > 1e-4) add("Lens distortion k1" to "%.4f".format(r.optDouble("k1")))
                    }
                    val sig = q.optDouble("sharpSigma", -1.0)
                    add("Sharpness" to if (sig > 0) "blur ≈ %.1f px".format(sig) + (if (sig > 2.2) " (soft)" else "") else "no texture to measure")
                    add("Clipped highlights" to "%.1f%%".format(q.optDouble("clipHi") * 100))
                }
                rows.forEach { (k, v) -> Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) { Text(k, Modifier.weight(1f), fontSize = 13.sp, color = Palette.dim); Text(v, fontSize = 13.sp) } }
                SectionLabel("Source")
                val e = f.meta.optJSONObject("exif") ?: JSONObject()
                val cam = listOf(e.optString("make"), e.optString("model")).filter { it.isNotEmpty() }.joinToString(" ")
                val shot = listOfNotNull(
                    e.optDouble("focalLength", 0.0).takeIf { it > 0 }?.let { "%.1f mm".format(it) },
                    e.optDouble("fNumber", 0.0).takeIf { it > 0 }?.let { "f/%.1f".format(it) },
                    e.optDouble("exposureTime", 0.0).takeIf { it > 0 }?.let { if (it < 1) "1/${Math.round(1 / it)} s" else "%.1f s".format(it) },
                    e.optDouble("iso", 0.0).takeIf { it > 0 }?.let { "ISO ${it.toInt()}" }).joinToString(" · ")
                Text(listOf(cam, shot, "${f.format.uppercase()} · ${f.meta.optInt("bitDepth", 8)}-bit · ${f.meta.optString("colorSpace")}",
                    "EXIF orientation ${f.orientation}" + if (f.working != null) " · decoded via device codec (original kept)" else "",
                    if ((f.j.optJSONArray("sidecars")?.length() ?: 0) > 0) "RAW sidecar stored with the project" else "").filter { it.isNotEmpty() }.joinToString("\n"),
                    fontSize = 13.sp, color = Palette.dim, lineHeight = 19.sp)
            }
        }
    }
}

/** Manual correspondence editor: pairs of matching points between the close-up (top) and the overview (bottom). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ManualPointsScreen(nav: Nav, s: Screen.Manual) {
    val p = rememberProject(s.dir, 0) ?: run { Box(Modifier.fillMaxSize().background(Palette.bg)); return }
    val f = p.frame(s.id) ?: run { LaunchedEffect(Unit) { nav.pop() }; return }
    val ov = p.overview ?: return
    val scope = rememberCoroutineScope()
    val srcF = remember(f.id) { frameSource(p, f) }
    val srcO = remember(ov.id) { frameSource(p, ov) }
    DisposableEffect(Unit) { onDispose { srcF.close(); srcO.close() } }
    val vpF = remember { ViewportState(f.width.toFloat(), f.height.toFloat()) }
    val vpO = remember { ViewportState(ov.width.toFloat(), ov.height.toFloat()) }
    val pairs = remember {
        mutableStateListOf<FloatArray>().apply {
            val a = f.manualPoints
            for (i in 0 until a.length()) a.getJSONObject(i).let { add(floatArrayOf(it.optDouble("fx").toFloat(), it.optDouble("fy").toFloat(), it.optDouble("ox").toFloat(), it.optDouble("oy").toFloat())) }
        }
    }
    var pending by remember { mutableStateOf<Offset?>(null) }
    fun save() {
        val arr = JSONArray()
        pairs.forEach { arr.put(JSONObject().put("fx", it[0]).put("fy", it[1]).put("ox", it[2]).put("oy", it[3])) }
        scope.launch {
            withContext(Dispatchers.IO) { runCatching { Core.call("frame.update", JSONObject().put("dir", s.dir.absolutePath).put("id", f.id).put("user", JSONObject().put("manualPoints", arr))) } }
            JobManager.register(s.dir)
            nav.pop()
        }
    }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Column { Text("Reference points", fontWeight = FontWeight.SemiBold); Text("${pairs.size} pair${if (pairs.size == 1) "" else "s"} · at least 4 needed", fontSize = 12.sp, color = Palette.dim) } },
                navigationIcon = { IconButton(onClick = { nav.pop() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = {
                    TextButton(enabled = pairs.isNotEmpty() || pending != null, onClick = { if (pending != null) pending = null else pairs.removeAt(pairs.lastIndex) }) { Text("Undo") }
                    TextButton(enabled = pairs.size >= 4 || (pairs.isEmpty() && f.manualPoints.length() > 0), onClick = { save() }, modifier = Modifier.testTag("btn_save_points")) { Text(if (pairs.isEmpty()) "Clear" else "Save") }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.bg),
            )
        },
        containerColor = Palette.bg,
    ) { pad ->
        Column(Modifier.fillMaxSize().padding(pad)) {
            Text(if (pending == null) "1 · Tap a distinctive point in the close-up (top). Pinch to zoom for precision." else "2 · Now tap the same point in the overview (bottom).",
                Modifier.fillMaxWidth().background(Palette.surfaceHi).padding(12.dp), fontSize = 13.sp)
            Box(Modifier.weight(1f).fillMaxWidth().background(Color.Black)) {
                TileViewer(vpF, listOf(TileLayer(srcF)), Modifier.testTag("manual_frame"), onTap = { c -> if (c.x in 0f..f.width.toFloat() && c.y in 0f..f.height.toFloat()) pending = c }, overlay = { v ->
                    pairs.forEachIndexed { i, pr -> drawMarker(v.toScreen(Offset(pr[0], pr[1])), "${i + 1}", Palette.teal) }
                    pending?.let { drawMarker(v.toScreen(it), "${pairs.size + 1}", Palette.amber) }
                })
            }
            Box(Modifier.fillMaxWidth().background(Palette.amber.copy(alpha = if (pending != null) 0.9f else 0.25f)).padding(vertical = 1.5.dp))
            Box(Modifier.weight(1f).fillMaxWidth().background(Color.Black)) {
                TileViewer(vpO, listOf(TileLayer(srcO)), Modifier.testTag("manual_overview"), onTap = { c ->
                    val pf = pending
                    if (pf != null && c.x in 0f..ov.width.toFloat() && c.y in 0f..ov.height.toFloat()) {
                        pairs.add(floatArrayOf(pf.x, pf.y, c.x, c.y)); pending = null
                    }
                }, overlay = { v -> pairs.forEachIndexed { i, pr -> drawMarker(v.toScreen(Offset(pr[2], pr[3])), "${i + 1}", Palette.teal) } })
            }
            Text("Spread the points over the whole close-up. The app refines your placement automatically when it finds matching detail; otherwise it uses your points as given.",
                Modifier.fillMaxWidth().background(Palette.surface).padding(12.dp).navigationBarsPadding(), fontSize = 12.sp, color = Palette.dim, lineHeight = 16.sp)
        }
    }
}
