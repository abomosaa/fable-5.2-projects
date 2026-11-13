package com.detailedcapture.app

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Redo
import androidx.compose.material.icons.automirrored.filled.Undo
import androidx.compose.material.icons.filled.AutoAwesomeMosaic
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material.icons.filled.ZoomIn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
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
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File

/** Colourises the core's detail-gain raster (8-bit, gain * 32) into a translucent overlay. */
fun colorizeCoverage(file: File): Bitmap? {
    val src = BitmapFactory.decodeFile(file.absolutePath) ?: return null
    val w = src.width
    val h = src.height
    val px = IntArray(w * h)
    src.getPixels(px, 0, w, 0, 0, w, h)
    for (i in px.indices) {
        val g = (px[i] and 0xFF) / 32f
        px[i] = when {
            g < 1.5f -> 0x00000000
            g < 2.0f -> 0x383DDBB4
            g < 3.0f -> 0x4C3DDBB4
            g < 4.0f -> 0x6030E0A0
            else -> 0x7828F08C
        }
    }
    return Bitmap.createBitmap(px, w, h, Bitmap.Config.ARGB_8888)
}

fun overviewSource(p: Project): RegionTileSource? {
    val ov = p.overview ?: return null
    val f = p.file(ov.working ?: ov.file)
    return RegionTileSource(f, if (ov.working != null) 1 else ov.orientation)
}

fun DrawScope.drawFootprint(vp: ViewportState, pts: List<android.graphics.PointF>, color: Color, fill: Boolean, width: Float, dashed: Boolean = false) {
    if (pts.size < 3) return
    val path = Path()
    pts.forEachIndexed { i, p ->
        val s = vp.toScreen(Offset(p.x, p.y))
        if (i == 0) path.moveTo(s.x, s.y) else path.lineTo(s.x, s.y)
    }
    path.close()
    if (fill) drawPath(path, color.copy(alpha = 0.10f))
    drawPath(path, color, style = Stroke(width, pathEffect = if (dashed) PathEffect.dashPathEffect(floatArrayOf(14f, 10f)) else null))
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProjectScreen(nav: Nav, dir: File) {
    var tick by remember { mutableIntStateOf(0) }
    var recovered by remember { mutableStateOf(false) }
    val project = rememberProject(dir, tick, recover = !recovered && !JobManager.isBusy(dir))
    LaunchedEffect(project != null) { if (project != null) recovered = true }
    val rev by JobManager.revision.collectAsState()
    val scope = rememberCoroutineScope()
    val snack = remember { SnackbarHostState() }
    val context = LocalContext.current
    var menu by remember { mutableStateOf(false) }
    var dialog by remember { mutableStateOf<String?>(null) }
    var showDetail by remember { mutableStateOf(true) }
    var target by remember { mutableStateOf<Rect?>(null) }
    var selected by remember { mutableStateOf<String?>(null) }

    val coverage by produceState<JSONObject?>(initialValue = null, dir, rev, tick, project?.overview?.id) {
        value = withContext(Dispatchers.IO) {
            if (project?.overview == null) null else runCatching { Core.call("coverage", JSONObject().put("dir", dir.absolutePath)) }.getOrNull()
        }
    }
    val covBitmap by produceState<Bitmap?>(initialValue = null, coverage) {
        value = withContext(Dispatchers.IO) { coverage?.optString("map")?.takeIf { it.isNotEmpty() }?.let { colorizeCoverage(File(dir, it)) } }
    }
    LaunchedEffect(Unit) {
        JobManager.events.collect { e ->
            if (e.projectDir == dir) {
                if (!e.ok && !e.cancelled) snack.showSnackbar(e.message ?: "Something went wrong")
                else if (e.cancelled) snack.showSnackbar("Cancelled. Nothing was lost; the previous result is intact.")
                else if (e.type == "export" && e.message != null) snack.showSnackbar(e.message)
            }
        }
    }
    val pickCloseups = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(60)) { uris ->
        if (uris.isNotEmpty()) {
            val hint = target?.let { JSONObject().put("x", it.left).put("y", it.top).put("w", it.width).put("h", it.height) }
            uris.forEach { u -> JobManager.addFrame(dir, "Importing photo") { Repo.importImage(dir, u, "closeup", hint) } }
            JobManager.register(dir)
        }
    }
    // recovery after a restart: adopt photos that were saved but never registered, and re-check frames whose
    // registration was interrupted
    LaunchedEffect(project?.j?.optString("modifiedAt"), rev) {
        val pr = project ?: return@LaunchedEffect
        if (pr.overview == null || JobManager.isBusy(dir)) return@LaunchedEffect
        val pending = withContext(Dispatchers.IO) { Repo.pendingIncoming(dir) }
        if (pending.isNotEmpty()) {
            pending.forEach { f -> JobManager.addFrame(dir, "Recovering photo") { Repo.adoptIncoming(dir, f) } }
            JobManager.register(dir)
        } else if (pr.count("unprocessed") > 0) JobManager.register(dir)
    }
    // Progress notifications are requested in context, the first time a long job is started. Declining is fine:
    // processing continues, only the notification is hidden.
    val notif = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    fun fuse() {
        val prefs = context.getSharedPreferences("dc", android.content.Context.MODE_PRIVATE)
        if (android.os.Build.VERSION.SDK_INT >= 33 && !prefs.getBoolean("askedNotif", false) &&
            androidx.core.content.ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            prefs.edit().putBoolean("askedNotif", true).apply()
            notif.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }
        JobManager.compose(dir)
    }
    val p = project
    if (p == null) {
        Box(Modifier.fillMaxSize().background(Palette.bg))
        return
    }
    val ov = p.overview
    val source = remember(ov?.id) { overviewSource(p) }
    DisposableEffect(source) { onDispose { source?.close() } }
    val vp = remember(ov?.id) { ViewportState((ov?.width ?: 1).toFloat(), (ov?.height ?: 1).toFloat()) }
    val busy = JobManager.state.collectAsState().value?.projectDir == dir

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(p.name, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold) },
                navigationIcon = { IconButton(onClick = { nav.pop() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = {
                    IconButton(enabled = p.canUndo, onClick = { scope.launch { withContext(Dispatchers.IO) { Core.call("undo", JSONObject().put("dir", dir.absolutePath)) }; tick++; JobManager.register(dir) } }) { Icon(Icons.AutoMirrored.Filled.Undo, "Undo") }
                    IconButton(enabled = p.canRedo, onClick = { scope.launch { withContext(Dispatchers.IO) { Core.call("redo", JSONObject().put("dir", dir.absolutePath)) }; tick++; JobManager.register(dir) } }) { Icon(Icons.AutoMirrored.Filled.Redo, "Redo") }
                    IconButton(onClick = { showDetail = !showDetail }) { Icon(Icons.Default.Layers, "Toggle detail map", tint = if (showDetail) Palette.teal else Palette.dim) }
                    IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, "More") }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(text = { Text("Rename") }, onClick = { menu = false; dialog = "rename" })
                        DropdownMenuItem(text = { Text("Output settings") }, onClick = { menu = false; dialog = "settings" })
                        DropdownMenuItem(text = { Text("Re-check all close-ups") }, onClick = { menu = false; JobManager.register(dir, full = true) })
                        DropdownMenuItem(text = { Text("Export project archive") }, onClick = { menu = false; Exports.archive(p, includeResult = false); dialog = "exported" })
                        DropdownMenuItem(text = { Text("Delete project") }, onClick = { menu = false; dialog = "delete" })
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.bg),
            )
        },
        snackbarHost = { SnackbarHost(snack) },
        containerColor = Palette.bg,
    ) { pad ->
        Column(Modifier.fillMaxSize().padding(pad)) {
            Box(Modifier.weight(1f).fillMaxWidth().background(Color.Black)) {
                if (source != null && ov != null) {
                    TileViewer(
                        vp, listOf(TileLayer(source)), Modifier.testTag("capture_map"),
                        onTap = { c ->
                            // tap a region: propose a close-up footprint there
                            val hit = p.closeups.lastOrNull { it.hasPosition && pointInPoly(c, it.footprint) }
                            if (hit != null && selected != hit.id && target == null) selected = hit.id
                            else {
                                selected = null
                                val sugg = coverage?.optJSONArray("gaps")?.optJSONObject(0)?.optDouble("suggestSize", 0.0) ?: 0.0
                                val w = (if (sugg > 0) sugg * 1.15 else ov.width / 3.0).toFloat().coerceIn(ov.width / 12f, ov.width / 1.5f)
                                val h = w * 0.75f
                                val cx = c.x.coerceIn(0f, ov.width.toFloat())
                                val cy = c.y.coerceIn(0f, ov.height.toFloat())
                                target = Rect(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)
                            }
                        },
                        overlay = { v ->
                            if (showDetail) covBitmap?.let { b ->
                                val tl = v.toScreen(Offset.Zero)
                                drawImage(b.asImageBitmap(), IntOffset.Zero, IntSize(b.width, b.height), IntOffset(tl.x.toInt(), tl.y.toInt()),
                                    IntSize((ov.width * v.scale).toInt(), (ov.height * v.scale).toInt()), filterQuality = FilterQuality.Low)
                            }
                            for (f in p.closeups) {
                                if (!f.hasPosition) continue
                                val st = f.displayStatus
                                val sel = f.id == selected
                                drawFootprint(v, f.footprint, Palette.status(st), fill = sel, width = if (sel) 5f else 2.5f, dashed = st != "accepted")
                            }
                            if (showDetail) coverage?.optJSONArray("gaps").objects().take(6).forEachIndexed { i, g ->
                                val c = v.toScreen(Offset(g.optDouble("cx").toFloat(), g.optDouble("cy").toFloat()))
                                val r = if (i == 0) 20f else 14f
                                drawCircle(Color.Black.copy(alpha = 0.55f), r + 3f, c)
                                drawCircle(Palette.amber, r, c, style = Stroke(3f))
                                drawLine(Palette.amber, Offset(c.x - r * 0.5f, c.y), Offset(c.x + r * 0.5f, c.y), 3f)
                                drawLine(Palette.amber, Offset(c.x, c.y - r * 0.5f), Offset(c.x, c.y + r * 0.5f), 3f)
                            }
                            target?.let { t ->
                                val a = v.toScreen(t.topLeft)
                                val b = v.toScreen(t.bottomRight)
                                drawRect(Color.White.copy(alpha = 0.10f), a, Size(b.x - a.x, b.y - a.y))
                                drawRect(Color.White, a, Size(b.x - a.x, b.y - a.y), style = Stroke(4f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(18f, 12f))))
                            }
                        },
                    )
                }
                // guidance bubble
                val guide = when {
                    ov == null -> "This project has no overview yet."
                    target != null -> "Selected area: photograph it from closer so it fills the frame (dashed box ≈ one close-up). Overlap neighbours by about a third."
                    p.closeups.isEmpty() -> "Tap an area of the overview, then capture or import close-ups of it."
                    selected != null -> null
                    (coverage?.optJSONArray("gaps")?.length() ?: 0) > 0 && p.count("accepted") > 0 -> "Amber + marks the largest low-detail gaps. Tap one to plan the next close-up."
                    else -> null
                }
                if (guide != null) Text(guide, Modifier.align(Alignment.TopCenter).padding(12.dp).clip(RoundedCornerShape(12.dp)).background(Color.Black.copy(alpha = 0.66f)).padding(horizontal = 12.dp, vertical = 8.dp),
                    fontSize = 13.sp, color = Color.White, lineHeight = 18.sp)
                selected?.let { id -> p.frame(id) }?.let { f ->
                    Row(Modifier.align(Alignment.TopCenter).padding(12.dp).clip(RoundedCornerShape(12.dp)).background(Color.Black.copy(alpha = 0.72f)).clickable { nav.push(Screen.FrameS(dir, f.id)) }
                        .padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        StatusDot(f.displayStatus); Spacer(Modifier.width(8.dp))
                        Text("${p.labelOf(f.id).substringBefore(" (")} · ${statusLabel(f.displayStatus)}" + (if (f.scale > 0) " · ${fmtGain(f.scale)} closer" else "") + " — tap for details", fontSize = 13.sp, color = Color.White)
                    }
                }
                if (target != null) TextButton(onClick = { target = null }, Modifier.align(Alignment.BottomEnd).padding(8.dp)) { Text("Clear selection") }
            }
            // ---- bottom panel -------------------------------------------------------------------------
            Column(Modifier.fillMaxWidth().background(Palette.surface).padding(horizontal = 14.dp).padding(top = 10.dp).navigationBarsPadding()) {
                val st = coverage?.optJSONObject("stats")
                val acc = p.count("accepted")
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        if (st != null && acc > 0) {
                            Text("${(st.optDouble("coveredFrac") * 100).toInt()}% verified at ≥1.5× detail", fontWeight = FontWeight.SemiBold, fontSize = 15.sp, modifier = Modifier.testTag("coverage_text"))
                            Text("median ${fmtGain(st.optDouble("medianGainCovered", 1.0))} · up to ${fmtGain(st.optDouble("maxGain", 1.0))} · estimated from accepted footprints and measured sharpness",
                                fontSize = 12.sp, color = Palette.dim, maxLines = 2, lineHeight = 16.sp)
                        } else {
                            Text(if (p.closeups.isEmpty()) "No close-ups yet" else "No verified close-ups yet", fontWeight = FontWeight.SemiBold, fontSize = 15.sp, modifier = Modifier.testTag("coverage_text"))
                            Text("Coverage counts only close-ups that passed alignment checks.", fontSize = 12.sp, color = Palette.dim)
                        }
                    }
                }
                Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Pill("$acc verified", Palette.teal)
                    if (p.count("uncertain") > 0) Pill("${p.count("uncertain")} uncertain", Palette.amber)
                    if (p.count("rejected") > 0) Pill("${p.count("rejected")} rejected", Palette.red)
                    if (p.count("unprocessed") > 0) Pill("${p.count("unprocessed")} waiting", Palette.blue)
                    if (p.count("excluded") > 0) Pill("${p.count("excluded")} excluded", Palette.dim)
                }
                if (p.registration?.optJSONObject("planarity")?.optBoolean("suspect") == true)
                    Text("Several close-ups disagree with a flat surface (depth, reflections or movement). Those parts are masked and shown from the overview instead. A flat mosaic cannot represent 3-D subjects.",
                        fontSize = 12.sp, color = Palette.amber, lineHeight = 16.sp, modifier = Modifier.padding(top = 8.dp).testTag("planarity_warning"))
                if (p.closeups.isNotEmpty()) LazyRow(Modifier.padding(top = 10.dp).testTag("filmstrip"), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(p.closeups, key = { it.id }) { f ->
                        val st2 = f.displayStatus
                        Box(Modifier.size(62.dp).clip(RoundedCornerShape(10.dp)).border(BorderStroke(if (f.id == selected) 3.dp else 2.dp, Palette.status(st2)), RoundedCornerShape(10.dp))
                            .clickable { nav.push(Screen.FrameS(dir, f.id)) }) {
                            Thumb(p.file(f.thumb), Modifier.fillMaxSize())
                            Box(Modifier.align(Alignment.BottomEnd).padding(4.dp)) { StatusDot(st2) }
                        }
                    }
                }
                val job = p.job
                val interrupted = !busy && job != null && job.optString("type") == "compose" && job.optString("state") in listOf("interrupted", "cancelled")
                if (busy) JobBanner(dir, Modifier.padding(top = 10.dp))
                else if (interrupted) Row(Modifier.padding(top = 10.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Palette.surfaceHi).padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(if (job?.optString("state") == "cancelled") "Fusion was cancelled. Finished tiles are kept." else "Fusion was interrupted. Finished tiles are kept.", Modifier.weight(1f), fontSize = 13.sp)
                    TextButton(onClick = { fuse() }) { Text("Resume") }
                }
                val res = p.result
                if (res != null && res.stale && !busy) Text("The fused result is out of date (frames or settings changed). Fuse again to update it; the current result stays available until then.",
                    fontSize = 12.sp, color = Palette.amber, modifier = Modifier.padding(top = 8.dp), lineHeight = 16.sp)
                Row(Modifier.padding(vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilledTonalButton(onClick = {
                        val hint = target?.let { JSONObject().put("x", it.left).put("y", it.top).put("w", it.width).put("h", it.height) }
                        nav.push(Screen.Camera(dir, "closeup", hint))
                    }, enabled = ov != null, modifier = Modifier.weight(1f).testTag("btn_capture"), contentPadding = PaddingValues(horizontal = 8.dp)) {
                        Icon(Icons.Default.CameraAlt, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("Capture", maxLines = 1)
                    }
                    FilledTonalButton(onClick = { pickCloseups.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }, enabled = ov != null,
                        modifier = Modifier.weight(1f).testTag("btn_import"), contentPadding = PaddingValues(horizontal = 8.dp)) {
                        Icon(Icons.Default.PhotoLibrary, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("Import", maxLines = 1)
                    }
                    if (res != null && !res.stale) Button(onClick = { nav.push(Screen.Viewer(dir)) }, modifier = Modifier.weight(1.1f).testTag("btn_view"), contentPadding = PaddingValues(horizontal = 8.dp)) {
                        Icon(Icons.Default.ZoomIn, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("View", maxLines = 1)
                    } else Button(onClick = { fuse() }, enabled = !busy && acc > 0, modifier = Modifier.weight(1.1f).testTag("btn_fuse"), contentPadding = PaddingValues(horizontal = 8.dp)) {
                        Icon(Icons.Default.AutoAwesomeMosaic, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("Fuse", maxLines = 1)
                    }
                }
                if (res != null && res.stale) OutlinedButton(onClick = { nav.push(Screen.Viewer(dir)) }, Modifier.fillMaxWidth().padding(bottom = 10.dp)) { Text("View previous result") }
            }
        }
    }

    when (dialog) {
        "rename" -> {
            var name by remember { mutableStateOf(p.name) }
            AlertDialog(onDismissRequest = { dialog = null }, title = { Text("Rename project") },
                text = { OutlinedTextField(name, { name = it }, singleLine = true) },
                confirmButton = { TextButton(onClick = { dialog = null; scope.launch { withContext(Dispatchers.IO) { Core.call("project.rename", JSONObject().put("dir", dir.absolutePath).put("name", name.ifBlank { p.name })) }; tick++ } }) { Text("Save") } },
                dismissButton = { TextButton(onClick = { dialog = null }) { Text("Cancel") } })
        }
        "settings" -> {
            var mp by remember { mutableFloatStateOf(p.settings.optDouble("maxOutputMP", 400.0).toFloat()) }
            var ms by remember { mutableFloatStateOf(p.settings.optDouble("maxScale", 8.0).toFloat()) }
            AlertDialog(onDismissRequest = { dialog = null }, title = { Text("Output settings") },
                text = {
                    Column {
                        Text("Maximum output size: ${mp.toInt()} MP", fontSize = 14.sp)
                        Slider(mp, { mp = it }, valueRange = 20f..1000f)
                        Text("Maximum enlargement of the overview grid: ${"%.1f".format(ms)}×", fontSize = 14.sp)
                        Slider(ms, { ms = it }, valueRange = 1f..12f)
                        Text("The output grid follows what the accepted close-ups actually resolve; these are upper bounds. Results are rendered in tiles, so large sizes need storage and time, not RAM. A bigger grid does not add detail.",
                            fontSize = 12.sp, color = Palette.dim, lineHeight = 16.sp)
                    }
                },
                confirmButton = { TextButton(onClick = { dialog = null; scope.launch { withContext(Dispatchers.IO) { Core.call("project.settings", JSONObject().put("dir", dir.absolutePath).put("settings", JSONObject().put("maxOutputMP", mp.toInt()).put("maxScale", Math.round(ms * 10) / 10.0))) }; tick++ } }) { Text("Save") } },
                dismissButton = { TextButton(onClick = { dialog = null }) { Text("Cancel") } })
        }
        "delete" -> AlertDialog(onDismissRequest = { dialog = null }, title = { Text("Delete project?") },
            text = { Text("This permanently deletes the overview, all close-ups and the fused result stored in this app. Exports you saved elsewhere are not affected.") },
            confirmButton = { TextButton(onClick = { dialog = null; JobManager.cancelAll(dir); scope.launch { withContext(Dispatchers.IO) { Repo.delete(dir) }; nav.pop() } }, colors = ButtonDefaults.textButtonColors(contentColor = Palette.red)) { Text("Delete") } },
            dismissButton = { TextButton(onClick = { dialog = null }) { Text("Cancel") } })
        "exported" -> ExportResultDialog(dir) { dialog = null }
    }
}

fun pointInPoly(p: Offset, poly: List<android.graphics.PointF>): Boolean {
    var inside = false
    var j = poly.size - 1
    for (i in poly.indices) {
        val a = poly[i]
        val b = poly[j]
        if ((a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside
        j = i
    }
    return inside
}

/** Shows export progress and, when done, native Share / Save-as actions. */
@Composable
fun ExportResultDialog(dir: File, onClose: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val st by JobManager.state.collectAsState()
    val done by Exports.last.collectAsState()
    var note by remember { mutableStateOf<String?>(null) }
    var start by remember { mutableStateOf(Exports.last.value) }
    val running = st?.projectDir == dir && st?.type == "export"
    val fresh = done.takeIf { it != null && it !== start }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri ->
        if (uri != null && fresh != null) scope.launch {
            note = withContext(Dispatchers.IO) { runCatching { Exports.copyTo(context, fresh, uri); "Saved." }.getOrElse { it.message ?: "Save failed" } }
        }
    }
    LaunchedEffect(Unit) {
        JobManager.events.collect { e -> if (e.projectDir == dir && e.type == "export" && !e.ok) note = if (e.cancelled) "Export cancelled." else (e.message ?: "Export failed.") }
    }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(if (fresh != null) "Export ready" else if (running) "Exporting…" else "Export") },
        text = {
            Column(Modifier.tagRoot()) {
                if (fresh != null) {
                    Text(fresh.file.name, fontWeight = FontWeight.Medium)
                    Text(fresh.summary, fontSize = 13.sp, color = Palette.dim, modifier = Modifier.padding(top = 4.dp))
                } else if (running) JobBanner(dir)
                else if (note == null) Text("Waiting to start…", color = Palette.dim)
                note?.let { Text(it, fontSize = 13.sp, color = Palette.amber, modifier = Modifier.padding(top = 8.dp)) }
            }
        },
        confirmButton = {
            if (fresh != null) Row(Modifier.tagRoot()) {
                TextButton(onClick = { save.launch(fresh.file.name) }) { Text("Save as…") }
                TextButton(onClick = { Exports.share(context, fresh) }, modifier = Modifier.testTag("btn_share")) { Text("Share") }
            }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("Close") } },
    )
}
