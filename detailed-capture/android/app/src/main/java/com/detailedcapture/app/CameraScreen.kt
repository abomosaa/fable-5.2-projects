package com.detailedcapture.app

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CaptureRequest
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.OptIn
import androidx.camera.camera2.interop.Camera2CameraControl
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.CaptureRequestOptions
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import androidx.camera.core.CameraInfo
import androidx.camera.core.CameraSelector
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.LockOpen
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
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
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import kotlin.math.sqrt

private data class Lens(val info: CameraInfo, val label: String, val id: String)

private data class Live(
    val found: Boolean = false, val quad: List<Offset> = emptyList(), val previewScale: Double = 0.0, val overlap: Double = 0.0,
    val sharpness: Double = 0.0, val clipHi: Double = 0.0, val clipLo: Double = 0.0, val analysisW: Int = 0, val stamp: Long = 0,
)

@OptIn(ExperimentalCamera2Interop::class)
private fun describe(info: CameraInfo, index: Int): Lens {
    val c2 = runCatching { Camera2CameraInfo.from(info) }.getOrNull()
    val id = c2?.cameraId ?: "$index"
    var label = "Camera $id"
    runCatching {
        val fl = c2?.getCameraCharacteristic(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.firstOrNull()
        val sensor = c2?.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)
        if (fl != null && sensor != null && sensor.width > 0) {
            val eq = fl * 43.27f / sqrt(sensor.width * sensor.width + sensor.height * sensor.height)
            label = when {
                eq < 20 -> "Ultra-wide ${eq.toInt()} mm"
                eq < 35 -> "Wide ${eq.toInt()} mm"
                else -> "Tele ${eq.toInt()} mm"
            }
        }
    }
    return Lens(info, label, id)
}

/** Camera capture for the overview or for close-ups, with live placement guidance on the overview. */
@OptIn(ExperimentalCamera2Interop::class)
@Composable
fun CameraScreen(nav: Nav, s: Screen.Camera) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()
    var tick by remember { mutableIntStateOf(0) }
    val project = rememberProject(s.dir, tick)
    var granted by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    var asked by remember { mutableStateOf(false) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok -> granted = ok; asked = true }
    LaunchedEffect(Unit) { if (!granted) permission.launch(Manifest.permission.CAMERA) }
    var captured by remember { mutableIntStateOf(0) }
    fun leave() {
        if (s.deleteIfEmpty && captured == 0) scope.launch { withContext(Dispatchers.IO) { runCatching { Repo.delete(s.dir) } }; nav.pop() }
        else if (s.role == "overview" && captured > 0) nav.replace(Screen.ProjectS(s.dir))
        else nav.pop()
    }
    BackHandler { leave() }

    if (!granted) {
        Column(Modifier.fillMaxSize().background(Palette.bg).padding(28.dp), verticalArrangement = Arrangement.Center) {
            Text("Camera access is needed to take photos", fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
            Text("Detailed Capture uses the camera only to take the overview and close-up photos you ask for. Photos stay on this device. You can also work entirely with imported photos.",
                color = Palette.dim, fontSize = 14.sp, lineHeight = 21.sp, modifier = Modifier.padding(top = 10.dp, bottom = 18.dp))
            Button(onClick = {
                if (asked && !androidx.core.app.ActivityCompat.shouldShowRequestPermissionRationale(context as android.app.Activity, Manifest.permission.CAMERA))
                    context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)))
                else permission.launch(Manifest.permission.CAMERA)
            }, modifier = Modifier.testTag("btn_grant")) { Text(if (asked) "Open settings / try again" else "Allow camera") }
            OutlinedButton(onClick = { leave() }, modifier = Modifier.padding(top = 8.dp)) { Text("Go back and import photos instead") }
        }
        return
    }

    val previewView = remember { PreviewView(context).apply { scaleType = PreviewView.ScaleType.FIT_CENTER; implementationMode = PreviewView.ImplementationMode.COMPATIBLE } }
    val analysisExecutor = remember { Executors.newSingleThreadExecutor() }
    var lenses by remember { mutableStateOf<List<Lens>>(emptyList()) }
    var lensIdx by remember { mutableIntStateOf(0) }
    var camera by remember { mutableStateOf<Camera?>(null) }
    var imageCapture by remember { mutableStateOf<ImageCapture?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var locked by remember { mutableStateOf(false) }
    var ev by remember { mutableFloatStateOf(0f) }
    var auto by remember { mutableStateOf(false) }
    var rawOn by remember { mutableStateOf(false) }
    var rawSupported by remember { mutableStateOf(false) }
    var live by remember { mutableStateOf(Live()) }
    var steady by remember { mutableStateOf(true) }
    var busyShot by remember { mutableStateOf(false) }
    var flash by remember { mutableStateOf<String?>(null) }
    var lastAutoCentre by remember { mutableStateOf<Offset?>(null) }
    var lastShotAt by remember { mutableStateOf(0L) }
    var captureW by remember { mutableIntStateOf(4000) }

    // ---- steadiness from the gyroscope ------------------------------------------------------------
    DisposableEffect(Unit) {
        val sm = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val gyro = sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
        var calmSince = 0L
        val l = object : SensorEventListener {
            override fun onSensorChanged(e: SensorEvent) {
                val w = sqrt(e.values[0] * e.values[0] + e.values[1] * e.values[1] + e.values[2] * e.values[2])
                val now = System.currentTimeMillis()
                if (w > 0.07f) calmSince = 0L else if (calmSince == 0L) calmSince = now
                val st = calmSince != 0L && now - calmSince > 450
                if (st != steady) steady = st
            }
            override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
        }
        if (gyro != null) sm.registerListener(l, gyro, SensorManager.SENSOR_DELAY_UI)
        onDispose { sm.unregisterListener(l); analysisExecutor.shutdown() }
    }

    // ---- bind use cases ---------------------------------------------------------------------------
    LaunchedEffect(lensIdx, rawOn) {
        try {
            val provider = withContext(Dispatchers.IO) { ProcessCameraProvider.getInstance(context).get() }
            val infos = provider.availableCameraInfos
            val back = infos.filter { it.lensFacing == CameraSelector.LENS_FACING_BACK }.ifEmpty { infos }
            if (back.isEmpty()) {
                error = "This device has no usable camera. You can still import photos."
                return@LaunchedEffect
            }
            lenses = back.mapIndexed { i, info -> describe(info, i) }
            val lens = lenses[lensIdx.coerceIn(0, lenses.lastIndex)]
            val caps = runCatching { ImageCapture.getImageCaptureCapabilities(lens.info) }.getOrNull()
            rawSupported = caps?.supportedOutputFormats?.contains(ImageCapture.OUTPUT_FORMAT_RAW_JPEG) == true
            val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
            val capBuilder = ImageCapture.Builder()
                .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
                .setJpegQuality(100)
                .setResolutionSelector(ResolutionSelector.Builder().setResolutionStrategy(ResolutionStrategy.HIGHEST_AVAILABLE_STRATEGY).build())
            if (rawOn && rawSupported) capBuilder.setOutputFormat(ImageCapture.OUTPUT_FORMAT_RAW_JPEG)
            val cap = capBuilder.build()
            val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
            var lastRun = 0L
            analysis.setAnalyzer(analysisExecutor) { img ->
                try {
                    val now = System.currentTimeMillis()
                    if (now - lastRun >= 650) {
                        lastRun = now
                        val plane = img.planes[0]
                        val dirArg = if (s.role == "closeup") s.dir.absolutePath else ""
                        val r = Core.locate(dirArg, plane.buffer, img.width, img.height, plane.rowStride, img.imageInfo.rotationDegrees)
                        val q = r.optJSONArray("quad")
                        live = Live(
                            found = r.optBoolean("found"),
                            quad = if (q != null) (0 until q.length()).map { Offset(q.getJSONArray(it).getDouble(0).toFloat(), q.getJSONArray(it).getDouble(1).toFloat()) } else emptyList(),
                            previewScale = r.optDouble("previewScale", 0.0), overlap = r.optDouble("overlapWithAccepted", 0.0),
                            sharpness = r.optDouble("sharpness", 0.0), clipHi = r.optDouble("clipHi", 0.0), clipLo = r.optDouble("clipLo", 0.0),
                            analysisW = r.optInt("w", img.width), stamp = now)
                    }
                } catch (_: Throwable) {
                } finally {
                    img.close()
                }
            }
            provider.unbindAll()
            camera = provider.bindToLifecycle(lifecycleOwner, lens.info.cameraSelector, preview, cap, analysis)
            imageCapture = cap
            captureW = cap.resolutionInfo?.let { maxOf(it.resolution.width, it.resolution.height) } ?: 4000
            locked = false
            error = null
        } catch (e: Exception) {
            error = "The camera could not be started (${e.message ?: e.javaClass.simpleName}). You can still import photos."
        }
    }
    DisposableEffect(Unit) { onDispose { runCatching { ProcessCameraProvider.getInstance(context).get().unbindAll() } } }

    fun setLock(on: Boolean) {
        val cam = camera ?: return
        runCatching {
            Camera2CameraControl.from(cam.cameraControl).setCaptureRequestOptions(
                CaptureRequestOptions.Builder()
                    .setCaptureRequestOption(CaptureRequest.CONTROL_AE_LOCK, on)
                    .setCaptureRequestOption(CaptureRequest.CONTROL_AWB_LOCK, on).build())
            if (!on) cam.cameraControl.cancelFocusAndMetering()
        }
        locked = on
    }

    fun shoot() {
        val cap = imageCapture ?: return
        if (busyShot) return
        if (Repo.freeBytes() < 96L * 1024 * 1024) {
            flash = "Storage is almost full. Free up space before taking more photos."
            return
        }
        busyShot = true
        lastShotAt = System.currentTimeMillis()
        val dir = File(s.dir, "originals").apply { mkdirs() }
        val stamp = System.currentTimeMillis().toString(36)
        val jpg = File(dir, ".incoming-$stamp.jpg")
        val dng = File(dir, "raw-$stamp.dng")
        val lens = lenses.getOrNull(lensIdx)
        val capMeta = JSONObject().put("lensId", lens?.id ?: "").put("lensLabel", lens?.label ?: "").put("aeLocked", locked).put("evIndex", ev.toInt()).put("auto", auto)
        val hint = s.hint
        val usingRaw = rawOn && rawSupported
        val cb = object : ImageCapture.OnImageSavedCallback {
            var pending = if (usingRaw) 2 else 1
            override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                if (--pending > 0) return
                busyShot = false
                captured++
                val sidecars = JSONArray().apply { if (usingRaw && dng.exists()) put("originals/${dng.name}") }
                val role = s.role
                if (role == "overview") {
                    flash = "Analysing overview…"
                    scope.launch {
                        val r = withContext(Dispatchers.IO) { runCatching { Repo.registerFile(s.dir, jpg, "jpg", "overview", null, "camera", "", capMeta, sidecars) } }
                        r.onSuccess { nav.replace(Screen.ProjectS(s.dir)) }.onFailure { captured--; flash = it.message }
                    }
                } else {
                    flash = "Captured — checking…"
                    JobManager.addFrame(s.dir, "Analysing close-up") { Repo.registerFile(s.dir, jpg, "jpg", "closeup", hint, "camera", "", capMeta, sidecars) }
                    JobManager.register(s.dir)
                }
            }
            override fun onError(e: ImageCaptureException) {
                busyShot = false
                jpg.delete()
                flash = "Capture failed: ${e.message ?: "camera error"}"
            }
        }
        val exec = ContextCompat.getMainExecutor(context)
        runCatching {
            if (usingRaw) cap.takePicture(ImageCapture.OutputFileOptions.Builder(dng).build(), ImageCapture.OutputFileOptions.Builder(jpg).build(), exec, cb)
            else cap.takePicture(ImageCapture.OutputFileOptions.Builder(jpg).build(), exec, cb)
        }.onFailure { busyShot = false; flash = "Capture failed: ${it.message}" }
    }

    // ---- guidance ---------------------------------------------------------------------------------
    val liveFresh = System.currentTimeMillis() - live.stamp < 2500
    val predicted = if (live.found && live.analysisW > 0) live.previewScale * captureW / live.analysisW else 0.0
    val accepted = project?.count("accepted") ?: 0
    val blurry = live.sharpness in 0.01..3.5
    val guidance: Pair<String, Color> = when {
        error != null -> error!! to Palette.red
        s.role == "overview" -> when {
            live.clipHi > 0.06 -> "Bright areas are clipping — lower the exposure" to Palette.amber
            blurry -> "Image looks soft — tap to focus and hold steady" to Palette.amber
            else -> "Fit the whole subject, square-on, in even light" to Color.White
        }
        live.clipHi > 0.08 -> "Highlights are clipping (glare?) — change angle or lower exposure" to Palette.amber
        live.clipLo > 0.5 -> "Too dark — add light or raise exposure" to Palette.amber
        !steady -> "Hold steady…" to Palette.amber
        blurry -> "Looks soft — tap to focus" to Palette.amber
        !liveFresh || !live.found -> (if (accepted > 0) "Can't place this view on the overview yet. If you are very close, step back for an intermediate shot (2–4× per step)." else "Looking for this area on the overview…") to Color.White
        predicted < 1.3 -> "Move closer — this would add almost no detail (%.1f×)".format(predicted) to Palette.amber
        predicted > 5.5 -> "Very close (%.1f×). It may need an intermediate shot to be verified.".format(predicted) to Palette.amber
        accepted > 0 && live.overlap < 0.08 -> "≈%.1f× detail · no overlap with verified area — fine if it matches the overview, safer with ~30%% overlap".format(predicted) to Color.White
        else -> "≈%.1f× detail · %d%% overlap with verified area — good".format(predicted, (live.overlap * 100).toInt()) to Palette.teal
    }
    // ---- auto capture: steady, placed, sharp, and a new position ------------------------------------
    LaunchedEffect(live, steady, auto) {
        if (!auto || s.role != "closeup" || busyShot || !steady || !live.found || !liveFresh || blurry || predicted < 1.3) return@LaunchedEffect
        if (System.currentTimeMillis() - lastShotAt < 1800) return@LaunchedEffect
        val c = Offset(live.quad.map { it.x }.average().toFloat(), live.quad.map { it.y }.average().toFloat())
        val sizeN = (live.quad.maxOf { it.x } - live.quad.minOf { it.x }).coerceAtLeast(0.01f)
        val prev = lastAutoCentre
        if (prev == null || (prev - c).getDistance() > 0.3f * sizeN) {
            lastAutoCentre = c
            shoot()
        }
    }
    LaunchedEffect(flash) { if (flash != null) { kotlinx.coroutines.delay(4500); flash = null } }
    val jobState by JobManager.state.collectAsState()
    LaunchedEffect(jobState == null) { tick++ }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView({ previewView }, Modifier.fillMaxSize().pointerInput(camera) {
            detectTapGestures { pos ->
                val cam = camera ?: return@detectTapGestures
                val pt = previewView.meteringPointFactory.createPoint(pos.x, pos.y)
                runCatching { cam.cameraControl.startFocusAndMetering(FocusMeteringAction.Builder(pt).apply { if (locked) disableAutoCancel() }.build()) }
                flash = if (locked) "Focus set and held" else "Focusing"
            }
        })
        // top bar
        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { leave() }, modifier = Modifier.clip(CircleShape).background(Color.Black.copy(alpha = 0.45f))) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Color.White) }
            Spacer(Modifier.width(8.dp))
            Text(if (s.role == "overview") "Overview photo" else "Close-ups", color = Color.White, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            if (rawSupported) FilterChip(selected = rawOn, onClick = { rawOn = !rawOn }, label = { Text("RAW+JPEG") })
        }
        // guidance banner
        Text(guidance.first, Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = 60.dp, start = 16.dp, end = 16.dp).clip(RoundedCornerShape(12.dp)).background(Color.Black.copy(alpha = 0.62f))
            .padding(horizontal = 12.dp, vertical = 8.dp).testTag("guidance"), color = guidance.second, fontSize = 14.sp, lineHeight = 19.sp)
        // mini-map with live placement
        val p = project
        val ov = p?.overview
        if (s.role == "closeup" && p != null && ov != null) {
            Box(Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(top = 118.dp, end = 12.dp).width(132.dp).aspectRatio(ov.width / ov.height.toFloat().coerceAtLeast(1f))
                .clip(RoundedCornerShape(8.dp)).border(1.dp, Color.White.copy(alpha = 0.6f), RoundedCornerShape(8.dp))) {
                Thumb(p.file(ov.thumb), Modifier.fillMaxSize())
                Canvas(Modifier.fillMaxSize()) {
                    fun n(x: Float, y: Float) = Offset(x / ov.width * size.width, y / ov.height * size.height)
                    for (f in p.closeups) if (f.hasPosition && f.displayStatus == "accepted") {
                        val path = Path()
                        f.footprint.forEachIndexed { i, pt -> val o = n(pt.x, pt.y); if (i == 0) path.moveTo(o.x, o.y) else path.lineTo(o.x, o.y) }
                        path.close()
                        drawPath(path, Palette.teal.copy(alpha = 0.35f)); drawPath(path, Palette.teal, style = Stroke(1.5f))
                    }
                    s.hint?.let { h ->
                        val a = n(h.optDouble("x").toFloat(), h.optDouble("y").toFloat())
                        drawRect(Color.White, a, Size((h.optDouble("w") / ov.width * size.width).toFloat(), (h.optDouble("h") / ov.height * size.height).toFloat()),
                            style = Stroke(2f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 5f))))
                    }
                    if (live.found && liveFresh && live.quad.size == 4) {
                        val path = Path()
                        live.quad.forEachIndexed { i, q -> val o = Offset(q.x * size.width, q.y * size.height); if (i == 0) path.moveTo(o.x, o.y) else path.lineTo(o.x, o.y) }
                        path.close()
                        drawPath(path, Palette.amber, style = Stroke(3f))
                    }
                }
            }
        }
        // bottom controls
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Color.Black.copy(alpha = 0.55f)).navigationBarsPadding().padding(horizontal = 14.dp, vertical = 10.dp)) {
            flash?.let { Text(it, color = Color.White, fontSize = 13.sp, modifier = Modifier.padding(bottom = 6.dp).testTag("camera_flash")) }
            // recent close-ups with their verdicts
            if (s.role == "closeup" && p != null && p.closeups.isNotEmpty()) LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(bottom = 8.dp)) {
                items(p.closeups.takeLast(8).reversed(), key = { it.id }) { f ->
                    val st = f.displayStatus
                    Box(Modifier.size(44.dp).clip(RoundedCornerShape(8.dp)).border(2.dp, Palette.status(st), RoundedCornerShape(8.dp)).clickable { nav.push(Screen.FrameS(s.dir, f.id)) }) {
                        Thumb(p.file(f.thumb), Modifier.fillMaxSize())
                    }
                }
            }
            val expState = camera?.cameraInfo?.exposureState
            if (expState != null && expState.isExposureCompensationSupported) Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Exposure", color = Color.White, fontSize = 12.sp, modifier = Modifier.width(64.dp))
                Slider(ev, { v ->
                    ev = Math.round(v).toFloat()
                    runCatching { camera?.cameraControl?.setExposureCompensationIndex(ev.toInt()) }
                }, valueRange = expState.exposureCompensationRange.lower.toFloat()..expState.exposureCompensationRange.upper.toFloat(), modifier = Modifier.weight(1f))
                Text("%+.1f EV".format(ev * expState.exposureCompensationStep.toFloat()), color = Color.White, fontSize = 12.sp, modifier = Modifier.width(60.dp))
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f), horizontalAlignment = Alignment.Start) {
                    FilterChip(selected = locked, onClick = { setLock(!locked) }, label = { Text(if (locked) "AE/AWB locked" else "Lock exposure") },
                        leadingIcon = { Icon(if (locked) Icons.Default.Lock else Icons.Default.LockOpen, null, Modifier.size(16.dp)) })
                    if (lenses.size > 1) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        lenses.forEachIndexed { i, l -> FilterChip(selected = i == lensIdx, onClick = { lensIdx = i }, label = { Text(l.label, fontSize = 11.sp) }) }
                    }
                }
                Box(Modifier.size(76.dp).clip(CircleShape).background(Color.White.copy(alpha = if (busyShot) 0.4f else 1f)).clickable(enabled = !busyShot && imageCapture != null) { shoot() }.testTag("shutter"),
                    contentAlignment = Alignment.Center) { Box(Modifier.size(62.dp).clip(CircleShape).border(3.dp, Color.Black, CircleShape)) }
                Column(Modifier.weight(1f), horizontalAlignment = Alignment.End) {
                    if (s.role == "closeup") FilterChip(selected = auto, onClick = { auto = !auto; lastAutoCentre = null }, label = { Text(if (auto) "Auto capture on" else "Auto capture") })
                    if (s.role == "closeup") Text("${p?.count("accepted") ?: 0} verified · ${captured} taken", color = Color.White, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp))
                    if (s.role == "closeup") OutlinedButton(onClick = { leave() }, modifier = Modifier.padding(top = 4.dp).height(34.dp)) { Text("Done", fontSize = 12.sp) }
                }
            }
        }
    }
}
