package dev.pocket3d.app.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import dev.pocket3d.core.net.PairingInfo
import dev.pocket3d.core.services.CompanionState
import dev.pocket3d.core.services.PairResult
import dev.pocket3d.core.services.Services
import dev.pocket3d.design.InfoBanner
import dev.pocket3d.design.LabeledValue
import dev.pocket3d.design.SectionTitle
import dev.pocket3d.design.StatusPill
import dev.pocket3d.design.Tone
import kotlinx.coroutines.launch
import java.util.concurrent.Executors

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PairingScreen(initialUri: String?, onBack: () -> Unit) {
    val state by Services.companion.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var uriText by rememberSaveable { mutableStateOf(initialUri ?: "") }
    var scanning by rememberSaveable { mutableStateOf(false) }
    var working by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<Pair<String, Tone>?>(null) }
    var confirmUnpair by remember { mutableStateOf(false) }
    val context = LocalContext.current
    LaunchedEffect(Unit) { Services.companion.refresh() }

    fun pair(info: PairingInfo) {
        working = true; message = null
        scope.launch {
            val name = "${Build.MANUFACTURER} ${Build.MODEL}".trim().take(60)
            when (val r = Services.companion.pair(info, name)) {
                is PairResult.Success -> { message = "Paired with ${r.serverName}" to Tone.Good; uriText = "" }
                is PairResult.Failure -> message = r.message to Tone.Bad
            }
            working = false
        }
    }
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) scanning = true
        else message = "Camera permission denied — paste or type the pairing link shown by the companion instead." to Tone.Warn
    }

    Scaffold(topBar = {
        TopAppBar(title = { Text("Companion computer") },
                  navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") } })
    }) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
               verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Reconstruction (camera solving, dense stereo, meshing, texturing) runs on a computer you control in your local " +
                     "network. The phone captures, checks, uploads, and then inspects, edits and exports the result. No cloud, no account, " +
                     "no internet needed.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            message?.let { (text, tone) -> InfoBanner(text, tone = tone) }
            if (state.paired) PairedCard(state, onRefresh = { scope.launch { Services.companion.refresh() } }, onUnpair = { confirmUnpair = true })

            SectionTitle(if (state.paired) "Pair a different companion" else "Pair")
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("1. On the computer, in the project folder, run", style = MaterialTheme.typography.bodyMedium)
                    Text("companion/run.sh", fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium)
                    Text("2. It prints a QR code and a pairing link. Phone and computer must be on the same network " +
                             "(Android emulator: the host computer is 10.0.2.2).", style = MaterialTheme.typography.bodyMedium)
                    Text("3. Scan the QR code, or paste the link below.", style = MaterialTheme.typography.bodyMedium)
                    if (scanning) {
                        QrScanner(Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(16.dp))) { text ->
                            val info = PairingInfo.parse(text)
                            if (info != null) { scanning = false; uriText = text; pair(info) }
                        }
                        TextButton(onClick = { scanning = false }) { Text("Stop scanning") }
                    } else {
                        Button(enabled = !working, onClick = {
                            if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) scanning = true
                            else cameraPermission.launch(Manifest.permission.CAMERA)
                        }) { Text("Scan QR code") }
                    }
                    OutlinedTextField(uriText, { uriText = it.trim() }, label = { Text("Pairing link") }, modifier = Modifier.fillMaxWidth(),
                                      placeholder = { Text("pocket3d://pair?v=1&host=…&port=…&fp=…&code=…") }, minLines = 2, maxLines = 5,
                                      textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
                    val parsed = remember(uriText) { PairingInfo.parse(uriText) }
                    if (uriText.isNotBlank() && parsed == null) {
                        Text("This is not a valid pairing link.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    }
                    parsed?.let { p ->
                        LabeledValue("Address", p.hosts.joinToString(", ") + ":" + p.port)
                        Text("Certificate fingerprint (must match the companion’s terminal):", style = MaterialTheme.typography.bodySmall,
                             color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(p.fingerprintSha256.chunked(4).joinToString(" "), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                    }
                    if (working) LinearProgressIndicator(Modifier.fillMaxWidth())
                    Button(enabled = parsed != null && !working, onClick = { parsed?.let(::pair) }) { Text("Pair") }
                }
            }
            InfoBanner("Privacy", tone = Tone.Neutral,
                       body = "Photos are uploaded only to the paired companion, over TLS pinned to its certificate fingerprint. The companion " +
                           "makes no outbound connections. Deleting a project can also delete the companion’s copies.")
            Spacer(Modifier.height(24.dp))
        }
    }
    if (confirmUnpair) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirmUnpair = false }, title = { Text("Unpair this companion?") },
            text = { Text("Running reconstructions on it can no longer be followed from this phone and will be shown as interrupted. " +
                              "Photos already uploaded stay on the companion until you delete them there.") },
            confirmButton = { TextButton(onClick = { confirmUnpair = false; scope.launch { Services.companion.unpair(); message = "Unpaired" to Tone.Neutral } }) { Text("Unpair") } },
            dismissButton = { TextButton(onClick = { confirmUnpair = false }) { Text("Cancel") } })
    }
}

@Composable
private fun PairedCard(state: CompanionState, onRefresh: () -> Unit, onUnpair: () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                val (text, tone) = companionSummary(state)
                StatusPill(text, tone)
                if (state.checking) StatusPill("Checking…", Tone.Neutral)
            }
            state.baseUrl?.let { LabeledValue("Address", it.removePrefix("https://")) }
            state.fingerprintSha256?.let { LabeledValue("Pinned certificate", it.take(16).chunked(4).joinToString(" ") + " …") }
            state.status?.let { st ->
                LabeledValue("Companion version", st.version)
                LabeledValue("Processor", st.hardware.cpuModel.ifBlank { "unknown" }.take(28))
                LabeledValue("Threads / memory per job", "${st.resources.jobThreads} / ${st.resources.jobMemoryMb / 1024} GB")
                LabeledValue("GPU", st.hardware.gpu ?: "not used (CPU reconstruction)")
                LabeledValue("Free disk", formatBytes(st.resources.diskFreeMb * 1024L * 1024L))
                LabeledValue("Jobs running / queued", "${st.queue.running} / ${st.queue.queued}")
                LabeledValue("Photo limits", "${st.limits.minImages}–${st.limits.maxImages} per job")
            }
            if (state.reachable == false) {
                InfoBanner("Not reachable right now", tone = Tone.Warn,
                           body = (state.lastError ?: "") + " Check that the companion is running and that phone and computer share a network.")
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onRefresh) { Text("Check connection") }
                TextButton(onClick = onUnpair) { Text("Unpair") }
            }
        }
    }
}

/** Live QR scanner: CameraX analysis frames decoded with ZXing (luma plane only, on-device). */
@Composable
private fun QrScanner(modifier: Modifier, onText: (String) -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val callback by rememberUpdatedState(onText)
    val executor = remember { Executors.newSingleThreadExecutor() }
    val previewView = remember { PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER } }
    DisposableEffect(Unit) {
        val providerFuture = ProcessCameraProvider.getInstance(context)
        val reader = MultiFormatReader().apply { setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE), DecodeHintType.TRY_HARDER to true)) }
        var provider: ProcessCameraProvider? = null
        providerFuture.addListener({
            val p = runCatching { providerFuture.get() }.getOrNull() ?: return@addListener
            provider = p
            val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
            val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
            analysis.setAnalyzer(executor) { image ->
                try {
                    val plane = image.planes[0]
                    val w = image.width; val h = image.height
                    val data = ByteArray(w * h)
                    val buf = plane.buffer
                    for (row in 0 until h) {
                        buf.position(row * plane.rowStride)
                        buf.get(data, row * w, minOf(w, buf.remaining()))
                    }
                    val source = PlanarYUVLuminanceSource(data, w, h, 0, 0, w, h, false)
                    val text = runCatching { reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text }.getOrNull()
                    reader.reset()
                    if (text != null) previewView.post { callback(text) }
                } catch (_: Exception) {
                } finally {
                    image.close()
                }
            }
            runCatching {
                p.unbindAll()
                p.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            }
        }, ContextCompat.getMainExecutor(context))
        onDispose {
            runCatching { provider?.unbindAll() }
            executor.shutdown()
        }
    }
    Box(modifier) { AndroidView({ previewView }, Modifier.fillMaxSize()) }
}
