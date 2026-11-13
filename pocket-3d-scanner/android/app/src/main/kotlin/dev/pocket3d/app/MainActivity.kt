package dev.pocket3d.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.mutableStateOf
import dev.pocket3d.app.ui.AppNav
import dev.pocket3d.design.Pocket3DTheme

class MainActivity : ComponentActivity() {
    /** A pocket3d://pair?… link that opened the app (consumed by the pairing screen). */
    private val pendingPairingUri = mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (savedInstanceState == null) pendingPairingUri.value = pairingUriOf(intent)
        setContent {
            Pocket3DTheme {
                AppNav(pendingPairingUri = pendingPairingUri.value, onPairingUriConsumed = { pendingPairingUri.value = null })
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        pairingUriOf(intent)?.let { pendingPairingUri.value = it }
    }

    private fun pairingUriOf(intent: Intent?): String? =
        intent?.takeIf { it.action == Intent.ACTION_VIEW }?.dataString?.takeIf { it.startsWith("pocket3d://pair", true) }
}
