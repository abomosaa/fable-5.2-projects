package dev.pocket3d.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import dev.pocket3d.capture.CaptureGuideScreen
import dev.pocket3d.capture.CaptureScreen
import dev.pocket3d.capture.FrameReviewScreen
import dev.pocket3d.capture.ImportPhotosScreen
import dev.pocket3d.viewer.ArPlacementScreen
import dev.pocket3d.viewer.ModelViewerScreen
import dev.pocket3d.viewer.SparsePreviewScreen

/** Route table of the whole app. Every destination is a real screen; there are no stubs. */
object Routes {
    const val LIBRARY = "library"
    const val SETTINGS = "settings"
    fun pairing(uri: String? = null) = if (uri == null) "pairing" else "pairing?uri=${android.net.Uri.encode(uri)}"
    fun project(pid: String) = "project/$pid"
    fun guide(pid: String) = "guide/$pid"
    fun capture(pid: String, sid: String? = null) = "capture/$pid" + (sid?.let { "?sid=$it" } ?: "")
    fun import(pid: String, sid: String? = null) = "import/$pid" + (sid?.let { "?sid=$it" } ?: "")
    fun review(pid: String, sid: String) = "review/$pid/$sid"
    fun job(pid: String, jid: String) = "job/$pid/$jid"
    fun sparse(pid: String, jid: String) = "sparse/$pid/$jid"
    fun viewer(pid: String, mid: String) = "viewer/$pid/$mid"
    fun ar(pid: String, mid: String) = "ar/$pid/$mid"
}

@Composable
fun AppNav(pendingPairingUri: String?, onPairingUriConsumed: () -> Unit,
           nav: NavHostController = rememberNavController()) {
    LaunchedEffect(pendingPairingUri) {
        if (pendingPairingUri != null) {
            nav.navigate(Routes.pairing(pendingPairingUri))
            onPairingUriConsumed()
        }
    }
    val str = NavType.StringType
    var pendingGuideFor by remember { mutableStateOf<String?>(null) }
    NavHost(nav, startDestination = Routes.LIBRARY) {
        composable(Routes.LIBRARY) {
            LibraryScreen(
                onOpenProject = { nav.navigate(Routes.project(it)) },
                // Open the project, then (once that screen is composed) the capture guide on top of it.
                onNewProject = { pid -> pendingGuideFor = pid; nav.navigate(Routes.project(pid)) },
                onOpenPairing = { nav.navigate(Routes.pairing()) },
                onOpenSettings = { nav.navigate(Routes.SETTINGS) },
            )
        }
        composable(Routes.SETTINGS) {
            SettingsScreen(onBack = { nav.popBackStack() }, onOpenPairing = { nav.navigate(Routes.pairing()) })
        }
        composable("pairing?uri={uri}", arguments = listOf(navArgument("uri") { type = str; nullable = true; defaultValue = null })) {
            PairingScreen(initialUri = it.arguments?.getString("uri"), onBack = { nav.popBackStack() })
        }
        composable("project/{pid}", arguments = listOf(navArgument("pid") { type = str })) { e ->
            val pid = e.arguments!!.getString("pid")!!
            LaunchedEffect(pid) {
                if (pendingGuideFor == pid) {
                    pendingGuideFor = null
                    nav.navigate(Routes.guide(pid))
                }
            }
            ProjectScreen(
                projectId = pid,
                onBack = { nav.popBackStack() },
                onGuide = { nav.navigate(Routes.guide(pid)) },
                onCapture = { sid -> nav.navigate(Routes.capture(pid, sid)) },
                onImport = { sid -> nav.navigate(Routes.import(pid, sid)) },
                onReview = { sid -> nav.navigate(Routes.review(pid, sid)) },
                onOpenJob = { jid -> nav.navigate(Routes.job(pid, jid)) },
                onOpenModel = { mid -> nav.navigate(Routes.viewer(pid, mid)) },
                onOpenAr = { mid -> nav.navigate(Routes.ar(pid, mid)) },
                onOpenPairing = { nav.navigate(Routes.pairing()) },
            )
        }
        composable("guide/{pid}", arguments = listOf(navArgument("pid") { type = str })) { e ->
            val pid = e.arguments!!.getString("pid")!!
            CaptureGuideScreen(
                onStartCapture = { nav.navigate(Routes.capture(pid)) { popUpTo(Routes.project(pid)) } },
                onImport = { nav.navigate(Routes.import(pid)) { popUpTo(Routes.project(pid)) } },
                onBack = { nav.popBackStack() },
            )
        }
        composable("capture/{pid}?sid={sid}", arguments = listOf(
            navArgument("pid") { type = str }, navArgument("sid") { type = str; nullable = true; defaultValue = null })) { e ->
            val pid = e.arguments!!.getString("pid")!!
            CaptureScreen(
                projectId = pid, sessionId = e.arguments?.getString("sid"),
                onFinished = { sid -> nav.navigate(Routes.review(pid, sid)) { popUpTo(Routes.project(pid)) } },
                onBack = { nav.popBackStack() },
                onImportInstead = { nav.navigate(Routes.import(pid)) { popUpTo(Routes.project(pid)) } },
            )
        }
        composable("import/{pid}?sid={sid}", arguments = listOf(
            navArgument("pid") { type = str }, navArgument("sid") { type = str; nullable = true; defaultValue = null })) { e ->
            val pid = e.arguments!!.getString("pid")!!
            ImportPhotosScreen(
                projectId = pid, sessionId = e.arguments?.getString("sid"),
                onImported = { sid -> nav.navigate(Routes.review(pid, sid)) { popUpTo(Routes.project(pid)) } },
                onBack = { nav.popBackStack() },
            )
        }
        composable("review/{pid}/{sid}", arguments = listOf(navArgument("pid") { type = str }, navArgument("sid") { type = str })) { e ->
            val pid = e.arguments!!.getString("pid")!!
            val sid = e.arguments!!.getString("sid")!!
            FrameReviewScreen(
                projectId = pid, sessionId = sid,
                onContinue = { nav.popBackStack(Routes.project(pid), inclusive = false) },
                onAddByCamera = { nav.navigate(Routes.capture(pid, sid)) },
                onBack = { nav.popBackStack() },
            )
        }
        composable("job/{pid}/{jid}", arguments = listOf(navArgument("pid") { type = str }, navArgument("jid") { type = str })) { e ->
            val pid = e.arguments!!.getString("pid")!!
            val jid = e.arguments!!.getString("jid")!!
            JobScreen(
                projectId = pid, jobId = jid, onBack = { nav.popBackStack() },
                onOpenSparsePreview = { nav.navigate(Routes.sparse(pid, jid)) },
                onOpenModel = { mid -> nav.navigate(Routes.viewer(pid, mid)) { popUpTo(Routes.project(pid)) } },
                onReviewPhotos = { sid -> nav.navigate(Routes.review(pid, sid)) },
            )
        }
        composable("sparse/{pid}/{jid}", arguments = listOf(navArgument("pid") { type = str }, navArgument("jid") { type = str })) { e ->
            SparsePreviewScreen(projectId = e.arguments!!.getString("pid")!!, jobId = e.arguments!!.getString("jid")!!,
                                onBack = { nav.popBackStack() })
        }
        composable("viewer/{pid}/{mid}", arguments = listOf(navArgument("pid") { type = str }, navArgument("mid") { type = str })) { e ->
            val pid = e.arguments!!.getString("pid")!!
            val mid = e.arguments!!.getString("mid")!!
            ModelViewerScreen(projectId = pid, modelId = mid, onBack = { nav.popBackStack() },
                              onOpenAr = { nav.navigate(Routes.ar(pid, mid)) },
                              onOpenPhoto = { sid, _ -> nav.navigate(Routes.review(pid, sid)) })
        }
        composable("ar/{pid}/{mid}", arguments = listOf(navArgument("pid") { type = str }, navArgument("mid") { type = str })) { e ->
            val pid = e.arguments!!.getString("pid")!!
            val mid = e.arguments!!.getString("mid")!!
            ArPlacementScreen(projectId = pid, modelId = mid, onBack = { nav.popBackStack() },
                              onOpenViewer = { nav.navigate(Routes.viewer(pid, mid)) { popUpTo(Routes.project(pid)) } })
        }
    }
}
