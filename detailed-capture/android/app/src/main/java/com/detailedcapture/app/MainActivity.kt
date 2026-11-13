package com.detailedcapture.app

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File

// ---------------------------------------------------------------------------------------------- theme
object Palette {
    val bg = Color(0xFF0E1114)
    val surface = Color(0xFF161B20)
    val surfaceHi = Color(0xFF1F262D)
    val teal = Color(0xFF3DDBB4)
    val amber = Color(0xFFFFB84D)
    val red = Color(0xFFFF6B6B)
    val blue = Color(0xFF6CB6FF)
    val text = Color(0xFFE8EAED)
    val dim = Color(0xFF9AA4AE)
    fun status(s: String) = when (s) {
        "accepted" -> teal
        "uncertain" -> amber
        "rejected" -> red
        "excluded" -> dim
        else -> blue
    }
}

private val scheme = darkColorScheme(
    primary = Palette.teal, onPrimary = Color(0xFF00382C), primaryContainer = Color(0xFF0F4A3D), onPrimaryContainer = Color(0xFFB9F6E4),
    secondary = Palette.amber, onSecondary = Color(0xFF442B00), secondaryContainer = Color(0xFF4A3410), onSecondaryContainer = Color(0xFFFFDDB0),
    tertiary = Palette.blue, background = Palette.bg, onBackground = Palette.text, surface = Palette.surface, onSurface = Palette.text,
    surfaceVariant = Palette.surfaceHi, onSurfaceVariant = Palette.dim, error = Palette.red, outline = Color(0xFF3A444E),
    surfaceContainer = Palette.surface, surfaceContainerHigh = Palette.surfaceHi, surfaceContainerLow = Color(0xFF12161A),
    surfaceContainerHighest = Color(0xFF28313A), surfaceContainerLowest = Palette.bg,
)

@Composable
fun DcTheme(content: @Composable () -> Unit) = MaterialTheme(colorScheme = scheme, content = content)

// ---------------------------------------------------------------------------------------------- nav
sealed interface Screen {
    data object Home : Screen
    data object About : Screen
    data class ProjectS(val dir: File) : Screen
    data class Camera(val dir: File, val role: String, val hint: JSONObject? = null, val deleteIfEmpty: Boolean = false) : Screen
    data class FrameS(val dir: File, val id: String, val fx: Float? = null, val fy: Float? = null) : Screen
    data class Manual(val dir: File, val id: String) : Screen
    data class Viewer(val dir: File) : Screen
}

class Nav {
    val stack = mutableStateListOf<Screen>(Screen.Home)
    val current: Screen get() = stack.last()
    fun push(s: Screen) { stack.add(s) }
    fun replace(s: Screen) { stack[stack.lastIndex] = s }
    fun pop(): Boolean = if (stack.size > 1) { stack.removeAt(stack.lastIndex); true } else false
}

class MainActivity : ComponentActivity() {
    private val shared = mutableStateOf<List<Uri>>(emptyList())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handleIntent(intent)
        setContent {
            DcTheme {
                @OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
                Surface(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }, color = MaterialTheme.colorScheme.background) {
                    val nav = remember { Nav() }
                    BackHandler(enabled = nav.stack.size > 1) { nav.pop() }
                    when (val s = nav.current) {
                        is Screen.Home -> HomeScreen(nav, shared.value) { shared.value = emptyList() }
                        is Screen.About -> AboutScreen(nav)
                        is Screen.ProjectS -> ProjectScreen(nav, s.dir)
                        is Screen.Camera -> CameraScreen(nav, s)
                        is Screen.FrameS -> FrameScreen(nav, s)
                        is Screen.Manual -> ManualPointsScreen(nav, s)
                        is Screen.Viewer -> ViewerScreen(nav, s.dir)
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    @Suppress("DEPRECATION")
    private fun handleIntent(intent: Intent?) {
        intent ?: return
        val uris = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java) else intent.getParcelableExtra(Intent.EXTRA_STREAM))
            Intent.ACTION_SEND_MULTIPLE -> (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)) ?: emptyList()
            else -> emptyList()
        }
        if (uris.isNotEmpty()) shared.value = uris
    }
}

// ---------------------------------------------------------------------------------------------- shared UI
/** Loads the project off the main thread and reloads whenever a job finishes or [tick] changes. */
@Composable
fun rememberProject(dir: File, tick: Int, recover: Boolean = false): Project? {
    val rev by JobManager.revision.collectAsState()
    val state = produceState<Project?>(initialValue = null, dir, tick, rev) {
        value = withContext(Dispatchers.IO) { runCatching { Repo.load(dir, recover) }.getOrNull() }
    }
    return state.value
}

@Composable
fun Thumb(file: File?, modifier: Modifier = Modifier, key: Any? = null) {
    val bmp by produceState<Bitmap?>(initialValue = null, file?.absolutePath, file?.lastModified(), key) {
        value = withContext(Dispatchers.IO) { file?.takeIf { it.exists() }?.let { runCatching { BitmapFactory.decodeFile(it.absolutePath) }.getOrNull() } }
    }
    Box(modifier.background(Palette.surfaceHi)) {
        bmp?.let { Image(it.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
    }
}

@Composable
fun StatusDot(status: String, modifier: Modifier = Modifier) {
    Box(modifier.size(10.dp).clip(RoundedCornerShape(5.dp)).background(Palette.status(status)))
}

@Composable
fun Pill(text: String, color: Color, modifier: Modifier = Modifier) {
    Text(text, modifier.clip(RoundedCornerShape(50)).background(color.copy(alpha = 0.16f)).padding(horizontal = 10.dp, vertical = 4.dp),
        color = color, fontSize = 12.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

/** Real progress of the running job for this project, with cancel. */
@Composable
fun JobBanner(dir: File?, modifier: Modifier = Modifier) {
    val st by JobManager.state.collectAsState()
    val s = st ?: return
    if (dir != null && s.projectDir != dir) return
    Column(modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Palette.surfaceHi).padding(horizontal = 14.dp, vertical = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(s.stage.ifEmpty { s.title }, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val sub = listOfNotNull(s.detail.takeIf { it.isNotEmpty() }, if (s.queued > 0) "${s.queued} more queued" else null).joinToString(" · ")
                if (sub.isNotEmpty()) Text(sub, fontSize = 12.sp, color = Palette.dim, maxLines = 1)
            }
            Text("${(s.fraction * 100).toInt()}%", fontSize = 13.sp, color = Palette.dim)
            TextButton(onClick = { JobManager.cancelAll(s.projectDir) }) { Text("Cancel") }
        }
        LinearProgressIndicator(progress = { s.fraction.toFloat().coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
    }
}

/** Exposes Compose test tags as resource ids inside separate windows (dialogs, bottom sheets) too. */
@OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
fun Modifier.tagRoot(): Modifier = this.semantics { testTagsAsResourceId = true }

@Composable
fun SectionLabel(text: String) = Text(text.uppercase(), fontSize = 11.sp, color = Palette.dim, fontWeight = FontWeight.SemiBold, letterSpacing = 1.2.sp, modifier = Modifier.padding(top = 14.dp, bottom = 6.dp))

fun fmtMP(mp: Double): String = if (mp >= 100) "%.0f MP".format(mp) else "%.1f MP".format(mp)
fun fmtGain(g: Double): String = "%.1f×".format(g)
fun fmtBytes(b: Long): String = when {
    b >= 1L shl 30 -> "%.2f GB".format(b / (1L shl 30).toDouble())
    b >= 1L shl 20 -> "%.1f MB".format(b / (1L shl 20).toDouble())
    else -> "%d KB".format(b / 1024)
}
