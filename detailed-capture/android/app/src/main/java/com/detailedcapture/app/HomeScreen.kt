package com.detailedcapture.app

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

fun defaultProjectName(): String = "Capture " + SimpleDateFormat("MMM d, HH:mm", Locale.US).format(Date())

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(nav: Nav, shared: List<Uri>, clearShared: () -> Unit) {
    var tick by remember { mutableIntStateOf(0) }
    val rev by JobManager.revision.collectAsState()
    val projects by produceState<List<Project>?>(initialValue = null, tick, rev) { value = withContext(Dispatchers.IO) { Repo.list() } }
    var sheet by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf<String?>(null) }
    val snack = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    fun createFrom(uris: List<Uri>) {
        if (uris.isEmpty()) return
        busy = "Importing overview…"
        scope.launch {
            val r = withContext(Dispatchers.IO) {
                runCatching {
                    val p = Repo.create(defaultProjectName())
                    try {
                        Repo.importImage(p.dir, uris.first(), "overview")
                    } catch (e: Exception) {
                        Repo.delete(p.dir); throw e
                    }
                    p
                }
            }
            busy = null
            r.onSuccess { p ->
                // any further shared photos become close-ups, processed in the background
                uris.drop(1).forEach { u -> JobManager.addFrame(p.dir, "Importing photo") { Repo.importImage(p.dir, u, "closeup") } }
                if (uris.size > 1) JobManager.register(p.dir)
                nav.push(Screen.ProjectS(p.dir))
            }.onFailure { snack.showSnackbar(it.message ?: "Import failed") }
        }
    }

    val pickOverview = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri -> if (uri != null) createFrom(listOf(uri)) }
    val pickArchive = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            busy = "Importing project archive…"
            scope.launch {
                val r = withContext(Dispatchers.IO) { runCatching { Repo.importArchive(uri) } }
                busy = null
                r.onSuccess { tick++; nav.push(Screen.ProjectS(it.dir)) }.onFailure { snack.showSnackbar(it.message ?: "Import failed") }
            }
        }
    }
    LaunchedEffect(shared) {
        if (shared.isNotEmpty()) {
            val u = shared; clearShared(); createFrom(u)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Detailed Capture", fontWeight = FontWeight.SemiBold)
                        Text("Overview + close-ups → one deeply zoomable image", fontSize = 12.sp, color = Palette.dim)
                    }
                },
                actions = { IconButton(onClick = { nav.push(Screen.About) }) { Icon(Icons.Default.Info, "About and limits") } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.bg),
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(onClick = { sheet = true }, icon = { Icon(Icons.Default.Add, null) }, text = { Text("New project") }, modifier = Modifier.testTag("new_project"))
        },
        snackbarHost = { SnackbarHost(snack) },
        containerColor = Palette.bg,
    ) { pad ->
        Box(Modifier.fillMaxSize().padding(pad)) {
            val list = projects
            when {
                list == null -> {}
                list.isEmpty() -> EmptyHome()
                else -> LazyColumn(contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 96.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    item { JobBanner(null) }
                    items(list, key = { it.dir.name }) { p -> ProjectCard(p) { nav.push(Screen.ProjectS(p.dir)) } }
                }
            }
            busy?.let { BusyOverlay(it) }
        }
    }
    if (sheet) {
        ModalBottomSheet(onDismissRequest = { sheet = false }, containerColor = Palette.surface) {
            Column(Modifier.tagRoot().navigationBarsPadding().padding(bottom = 12.dp)) {
                Text("Start with an overview", Modifier.padding(horizontal = 24.dp, vertical = 8.dp), fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                Text("One photo of the whole flat subject (painting, poster, document, wall). Close-ups are added next.",
                    Modifier.padding(horizontal = 24.dp).padding(bottom = 8.dp), fontSize = 13.sp, color = Palette.dim)
                SheetItem(Icons.Default.CameraAlt, "Take overview photo", "Use the camera with focus and exposure control") {
                    sheet = false
                    scope.launch {
                        val p = withContext(Dispatchers.IO) { runCatching { Repo.create(defaultProjectName()) } }
                        p.onSuccess { nav.push(Screen.Camera(it.dir, "overview", deleteIfEmpty = true)) }.onFailure { snack.showSnackbar(it.message ?: "Could not create project") }
                    }
                }
                SheetItem(Icons.Default.PhotoLibrary, "Import overview photo", "Pick an existing photo; the original file is kept unchanged") {
                    sheet = false
                    pickOverview.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                }
                SheetItem(Icons.Default.Archive, "Open project archive", "Restore a project exported from this app (.dcap.zip)") {
                    sheet = false
                    pickArchive.launch(arrayOf("application/zip", "application/octet-stream", "*/*"))
                }
            }
        }
    }
}

@Composable
fun SheetItem(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, sub: String, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(title) }, supportingContent = { Text(sub, color = Palette.dim, fontSize = 12.sp) },
        leadingContent = { Icon(icon, null, tint = Palette.teal) },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = Modifier.clickable(onClick = onClick),
    )
}

@Composable
fun BusyOverlay(text: String) {
    Box(Modifier.fillMaxSize().clickable(enabled = false) {}.padding(24.dp), contentAlignment = Alignment.Center) {
        Row(Modifier.clip(RoundedCornerShape(16.dp)).then(Modifier).padding(0.dp), verticalAlignment = Alignment.CenterVertically) {
            androidx.compose.material3.Surface(color = Palette.surfaceHi, shape = RoundedCornerShape(16.dp), tonalElevation = 6.dp) {
                Row(Modifier.padding(20.dp), verticalAlignment = Alignment.CenterVertically) {
                    androidx.compose.material3.CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(14.dp))
                    Text(text)
                }
            }
        }
    }
}

@Composable
private fun EmptyHome() {
    Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text("No projects yet", fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(10.dp))
        Text("1. Photograph the whole subject.\n2. Tap an area and add overlapping close-ups.\n3. Watch verified detail fill the map, then fuse and zoom in.",
            color = Palette.dim, fontSize = 14.sp, lineHeight = 22.sp)
        Spacer(Modifier.height(10.dp))
        Text("Works best on flat, static, textured subjects. Close-ups supply the detail — nothing is invented.", color = Palette.dim, fontSize = 13.sp)
    }
}

@Composable
private fun ProjectCard(p: Project, onClick: () -> Unit) {
    val ov = p.overview
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).clickable(onClick = onClick).then(Modifier).padding(0.dp)) {
        androidx.compose.material3.Surface(color = Palette.surface, shape = RoundedCornerShape(18.dp)) {
            Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Thumb(ov?.let { p.file(it.thumb) }, Modifier.size(84.dp).clip(RoundedCornerShape(12.dp)))
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    Text(p.name, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val acc = p.count("accepted")
                    val line = when {
                        ov == null -> "No overview yet"
                        p.closeups.isEmpty() -> "Overview ${ov.width} × ${ov.height} · no close-ups yet"
                        else -> "$acc of ${p.closeups.size} close-ups verified"
                    }
                    Text(line, fontSize = 13.sp, color = Palette.dim, maxLines = 1)
                    Spacer(Modifier.height(6.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        val r = p.result
                        if (r != null) Pill("${r.width} × ${r.height} · ${fmtGain(r.scale)} grid", if (r.stale) Palette.amber else Palette.teal)
                        if (r?.stale == true) Pill("out of date", Palette.amber)
                        if (p.job?.optString("type") == "compose" && p.job?.optString("state") in listOf("interrupted", "cancelled", "running") && !JobManager.isBusy(p.dir)) Pill("fusion interrupted", Palette.amber)
                        if (p.count("uncertain") > 0) Pill("${p.count("uncertain")} uncertain", Palette.amber)
                        if (p.count("rejected") > 0) Pill("${p.count("rejected")} rejected", Palette.red)
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AboutScreen(nav: Nav) {
    Scaffold(topBar = {
        TopAppBar(title = { Text("About & limits") }, navigationIcon = { IconButton(onClick = { nav.pop() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.bg))
    }, containerColor = Palette.bg) { pad ->
        Column(Modifier.padding(pad).padding(horizontal = 20.dp).verticalScroll(rememberScrollState())) {
            @Composable fun H(t: String) = Text(t, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, modifier = Modifier.padding(top = 18.dp, bottom = 6.dp))
            @Composable fun P(t: String) = Text(t, fontSize = 14.sp, color = Palette.text.copy(alpha = 0.86f), lineHeight = 21.sp, modifier = Modifier.padding(bottom = 6.dp))
            H("What this app does")
            P("It registers close-up photographs onto an overview photograph of the same flat subject and composites them into one large image. Every output pixel comes from one of your photographs. There is no generative enhancement, no AI upscaling and no added sharpening: where no verified close-up exists, the result shows the enlarged overview and labels it as lower detail.")
            H("How to capture")
            P("• Overview: whole subject, square-on, even light, sharp.\n• Close-ups: move closer (about 2–4× is ideal per step), keep the phone roughly parallel to the surface, overlap neighbouring shots by about a third.\n• If a very close shot is rejected, add an intermediate shot from in-between: matching across more than ~4–5× scale difference in one step is unreliable.\n• Lock focus/exposure for consistent colour. Avoid your own shadow and reflections.")
            H("What it cannot do")
            P("• 3-D objects: a planar model cannot represent parallax or occlusion. Frames whose geometry disagrees with a flat surface are masked or rejected, with an explanation.\n• Repeating patterns and blank areas: when several positions fit equally well the frame is marked uncertain rather than guessed. Use an intermediate frame with a unique landmark or place it manually with reference points.\n• Glass, gloss, transparencies, changing light, moving subjects: reflections and changes differ between shots; affected regions are masked or flagged.\n• Lost information: blur, clipped highlights and noise cannot be recovered by combining photos.")
            H("Reading the numbers")
            P("Output pixel dimensions are not detail. The app reports an estimate of genuine detail separately, from how densely each accepted close-up samples the subject and how sharp it measured. The coverage map shows that estimate, not the number of photos.")
            H("Measurement")
            P("Visual detail is not certified measurement accuracy. Distances are shown in pixels unless you provide a reference length on the same flat plane; calibrated values are estimates with a stated uncertainty and assume a square-on, distortion-free overview.")
            H("Formats")
            P("Sources: JPEG and PNG natively; HEIC/WebP/TIFF/DNG through the device decoder (a lossless working copy is made, the original is kept). Processing and export are 8 bits per channel in the overview's colour space (sRGB or Display P3 profile passed through).\nExport: PNG and TIFF (lossless, streamed, any size; BigTIFF above 4 GB), JPEG (max 65,535 px per side), Deep Zoom tile package with offline viewer for very large results, and project archives.")
            H("Privacy")
            P("Everything runs on this device. No account, no network access, no uploads.")
            H("Open-source components")
            P("OpenCV 4.12.0 (Apache-2.0) incl. libjpeg-turbo, libpng, libtiff, libwebp, zlib; nlohmann/json 3.12.0 (MIT); AndroidX, Jetpack Compose, CameraX, Kotlin (Apache-2.0). Full license texts ship with the source distribution (LICENSES.md).")
            Spacer(Modifier.height(32.dp))
            Text("Detailed Capture 1.0.0", color = Palette.dim, fontSize = 12.sp)
            Spacer(Modifier.height(24.dp))
        }
    }
}
