package dev.pocket3d.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import dev.pocket3d.core.services.Services
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.io.File

/**
 * Builds the data layer and publishes it through [Services]. Call once from
 * `Application.onCreate` (further calls do nothing).
 *
 * Storage: `filesDir/projects` (projects), `filesDir/companion/pairing.json` (pairing; the token
 * is encrypted with an Android Keystore key). Opening the project store scans it synchronously
 * (metadata only, plus crash repair when needed).
 */
object DataModule {
    private val lock = Any()
    @Volatile private var installed = false

    /** The concrete instances behind [Services], for wiring that needs more than the interfaces. */
    lateinit var store: FileProjectStore
        private set
    lateinit var companionLink: CompanionLinkImpl
        private set
    lateinit var syncEngine: SyncEngine
        private set

    fun install(context: Context) {
        synchronized(lock) {
            if (installed) return
            val app = context.applicationContext
            val projectStore = FileProjectStore(File(app.filesDir, "projects"))
            val pairings = FilePairingStore(File(File(app.filesDir, "companion"), "pairing.json"), AndroidKeystoreTokenCipher())
            val link = CompanionLinkImpl(pairings, CompanionApiFactory { baseUrl, fingerprint, token, quick ->
                CompanionClient(baseUrl, fingerprint, token,
                    timeouts = if (quick) CompanionClient.Timeouts(connectMs = 2_500, readMs = 5_000, writeMs = 5_000)
                    else CompanionClient.Timeouts())
            })
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
            val engine = SyncEngine(projectStore, link, scope, AndroidSyncKeepAlive(app))
            link.setOnChanged { engine.wake() }

            store = projectStore
            companionLink = link
            syncEngine = engine
            Services.store = projectStore
            Services.importer = AndroidPhotoImporter(app, projectStore, limits = { link.state.value.status?.limits })
            Services.companion = link
            Services.reconstruction = engine
            installed = true

            engine.resumeActiveJobs()
            scope.launch { link.refresh() }
            watchNetwork(app, scope, link, engine)
        }
    }

    /** Wi-Fi came back: check the companion and continue waiting jobs immediately. */
    private fun watchNetwork(app: Context, scope: CoroutineScope, link: CompanionLinkImpl, engine: SyncEngine) {
        try {
            val cm = app.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    scope.launch {
                        link.refresh()
                        engine.wake()
                    }
                }
            })
        } catch (_: Exception) {
            // Without the callback jobs still retry on their back-off timer.
        }
    }
}
