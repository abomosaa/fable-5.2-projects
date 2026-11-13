package dev.pocket3d.capture

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.pocket3d.design.InfoBanner
import dev.pocket3d.design.Tone

internal fun Context.findActivity(): Activity? {
    var c: Context? = this
    while (c is ContextWrapper) {
        if (c is Activity) return c
        c = c.baseContext
    }
    return null
}

internal fun Context.hasCameraPermission(): Boolean =
    ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

/**
 * Shows [content] only while the camera permission is granted. Otherwise a complete screen:
 * why the camera is needed, a button to grant it, and — once the system no longer shows its
 * dialog (denied twice / "don't ask again") — a way into the app settings. Importing photos is
 * always offered, so this is never a dead end. The grant is re-checked on every resume, so
 * returning from the settings app continues straight into capture.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CapturePermissionGate(onBack: () -> Unit, onImportInstead: () -> Unit, content: @Composable () -> Unit) {
    val context = LocalContext.current
    var granted by remember { mutableStateOf(context.hasCameraPermission()) }
    // Survives rotation and process death: the system dialog was already answered with "deny".
    var deniedOnce by rememberSaveable { mutableStateOf(false) }
    var permanentlyDenied by rememberSaveable { mutableStateOf(false) }

    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                granted = context.hasCameraPermission()
                if (granted) permanentlyDenied = false
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        granted = ok
        if (!ok) {
            val activity = context.findActivity()
            // After a denial the platform reports "no rationale" only when it will not ask again.
            val canAskAgain = activity != null &&
                ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.CAMERA)
            // (A dialog dismissed without an answer looks the same, hence the "Ask again" button below.)
            permanentlyDenied = !canAskAgain
            deniedOnce = true
        }
    }

    if (granted) {
        content()
        return
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Camera access") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back") }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Icon(Icons.Outlined.PhotoCamera, contentDescription = null, modifier = Modifier.size(56.dp),
                 tint = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.height(16.dp))
            Text("The camera is needed to take the photos", style = MaterialTheme.typography.titleLarge,
                 textAlign = TextAlign.Center)
            Spacer(Modifier.height(8.dp))
            Text(
                "Photos are taken with this phone's camera and stored inside the app. They leave the phone " +
                    "only when you send them to your own paired companion computer for reconstruction.",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(20.dp))
            if (permanentlyDenied) {
                InfoBanner(
                    title = "Camera access is turned off for this app",
                    body = "Android no longer shows the permission dialog. Open the app settings, choose " +
                        "Permissions → Camera and allow it, then come back.",
                    tone = Tone.Warn,
                )
                Spacer(Modifier.height(16.dp))
                Button(onClick = { openAppSettings(context) }, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
                    Text("Open settings")
                }
            } else {
                if (deniedOnce) {
                    InfoBanner(
                        title = "Camera access was not granted",
                        body = "Without it the app cannot take photos. You can allow it now, or import photos " +
                            "you took with another camera.",
                        tone = Tone.Warn,
                    )
                    Spacer(Modifier.height(16.dp))
                }
                Button(onClick = { launcher.launch(Manifest.permission.CAMERA) },
                       modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
                    Text("Allow camera access")
                }
            }
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = onImportInstead, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
                Text("Import photos instead")
            }
            if (permanentlyDenied) {
                TextButton(onClick = { launcher.launch(Manifest.permission.CAMERA) }, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text("Ask again")
                }
            }
        }
    }
}

private fun openAppSettings(context: Context) {
    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try { context.startActivity(intent) } catch (_: Throwable) { }
}
