package dev.pocket3d.viewer.ar

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.ar.core.Config
import com.google.ar.core.Session
import com.google.ar.core.exceptions.CameraNotAvailableException
import com.google.ar.core.exceptions.UnavailableApkTooOldException
import com.google.ar.core.exceptions.UnavailableArcoreNotInstalledException
import com.google.ar.core.exceptions.UnavailableDeviceNotCompatibleException
import com.google.ar.core.exceptions.UnavailableSdkTooOldException
import dev.pocket3d.core.edit.EditEngine
import dev.pocket3d.core.services.ArRuntimeStatus
import dev.pocket3d.viewer.data.ModelLoadException
import dev.pocket3d.viewer.data.ModelLoader
import dev.pocket3d.viewer.scene.MeshBuffers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.max

sealed interface ArModelState {
    data class Loading(val message: String) : ArModelState
    data class Failed(val title: String, val detail: String) : ArModelState
    data object Ready : ArModelState
}

data class ArUiState(
    val model: ArModelState = ArModelState.Loading("Opening model…"),
    val title: String = "Model",
    val sizing: ArSizing? = null,
    val status: ArStatus = ArStatus(),
    val matchBrightness: Boolean = true,
    val faceCount: Int = 0,
)

/** Why a session could not be created, for the explanation screen. */
class ArSessionProblem(val title: String, val detail: String)

/**
 * Holds what must survive a rotation of the AR screen: the loaded (edited) mesh, the ARCore
 * session and the placement. The session is closed when the screen is left for good.
 */
class ArViewModel(private val projectId: String, private val modelId: String) : ViewModel() {
    private val _state = MutableStateFlow(ArUiState())
    val state: StateFlow<ArUiState> = _state
    val placement = ArPlacement()
    var buffers: MeshBuffers? = null
        private set
    var session: Session? = null
        private set
    private var resumed = false

    init { load() }

    fun load() {
        viewModelScope.launch {
            _state.update { it.copy(model = ArModelState.Loading("Opening model…")) }
            try {
                val lm = ModelLoader.load(projectId, modelId) { stage -> _state.update { it.copy(model = ArModelState.Loading(stage)) } }
                // AR shows the model as it is now: the edited mesh, and bounds of the edited mesh.
                val b = withContext(Dispatchers.Default) { MeshBuffers.build(lm.current) }
                buffers = b
                val size = b.bounds.size
                val sizing = ArSizing(EditEngine.effectiveScale(lm.doc, lm.reconstructionScale), max(size.x, max(size.y, size.z)))
                placement.metersPerUnit = sizing.metersPerUnit ?: 0f
                _state.update {
                    it.copy(model = ArModelState.Ready, title = lm.model.name.ifBlank { "Model" }, sizing = sizing, faceCount = lm.current.faceCount)
                }
            } catch (e: ModelLoadException) {
                _state.update { it.copy(model = ArModelState.Failed(e.title, e.detail)) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: OutOfMemoryError) {
                _state.update { it.copy(model = ArModelState.Failed("Not enough memory", "The model is too large to place in AR on this device.")) }
            } catch (e: Exception) {
                _state.update { it.copy(model = ArModelState.Failed("The model could not be opened", e.message ?: e.javaClass.simpleName)) }
            }
        }
    }

    private fun setSizing(transform: (ArSizing) -> ArSizing) {
        val cur = _state.value.sizing ?: return
        val next = transform(cur)
        placement.metersPerUnit = next.metersPerUnit ?: 0f
        _state.update { it.copy(sizing = next) }
    }

    fun setUnlocked(on: Boolean) = setSizing { it.unlock(on) }
    fun pinch(zoom: Float) = setSizing { it.pinch(zoom) }
    fun setManualLongest(meters: Float) = setSizing { it.withManualLongest(meters) }
    fun twist(deltaRad: Float) { placement.yawRad += deltaRad }
    fun setMatchBrightness(on: Boolean) { placement.matchBrightness = on; _state.update { it.copy(matchBrightness = on) } }
    fun onStatus(s: ArStatus) = _state.update { it.copy(status = s) }
    fun send(input: ArInput) { placement.input.add(input) }

    /**
     * Creates and configures the session if there is none. Requires ARCore to be installed and
     * the camera permission to be granted. Returns the reason when that is not possible.
     */
    fun ensureSession(context: Context): ArSessionProblem? {
        if (session != null) return null
        return try {
            val s = Session(context)
            val config = Config(s).apply {
                planeFindingMode = Config.PlaneFindingMode.HORIZONTAL
                lightEstimationMode = Config.LightEstimationMode.AMBIENT_INTENSITY
                updateMode = Config.UpdateMode.LATEST_CAMERA_IMAGE
                focusMode = Config.FocusMode.AUTO
            }
            s.configure(config)
            session = s
            ArRuntimeStatus.reportStarted()
            null
        } catch (e: UnavailableArcoreNotInstalledException) {
            ArSessionProblem("Google Play Services for AR is not installed", "AR placement needs it. Install it from the Play Store and try again.")
        } catch (e: UnavailableApkTooOldException) {
            ArSessionProblem("Google Play Services for AR is out of date", "Update it in the Play Store and try again.")
        } catch (e: UnavailableSdkTooOldException) {
            ArSessionProblem("This app is too old for the installed AR services", "Update the app to use AR placement.")
        } catch (e: UnavailableDeviceNotCompatibleException) {
            ArSessionProblem("AR is not supported on this device", "This phone is not certified for ARCore, so the model cannot be placed in the room.")
        } catch (e: SecurityException) {
            ArSessionProblem("Camera permission is missing", "AR needs the camera to see the room.")
        } catch (e: Exception) {
            ArRuntimeStatus.reportFailed(e.javaClass.simpleName)
            ArSessionProblem("AR could not be started", arFailureText(e))
        }
    }

    /** Returns a message when the camera cannot be opened. */
    fun resumeSession(): String? {
        val s = session ?: return null
        if (resumed) return null
        return try {
            s.resume()
            resumed = true
            null
        } catch (e: CameraNotAvailableException) {
            "The camera is not available. Another app may be using it — close it and try again."
        } catch (e: SecurityException) {
            "The camera permission was withdrawn."
        } catch (e: Exception) {
            "AR could not be resumed: ${e.message ?: e.javaClass.simpleName}"
        }
    }

    fun pauseSession() {
        if (!resumed) return
        resumed = false
        try { session?.pause() } catch (e: Exception) { /* already paused or closed */ }
    }

    override fun onCleared() {
        pauseSession()
        placement.release()
        val s = session
        session = null
        // close() can block for a while; it must not hold up leaving the screen
        if (s != null) Thread({ try { s.close() } catch (e: Exception) { /* nothing to do */ } }, "arcore-close").start()
    }
}


/** Plain-language text for an ARCore failure that has no specific exception type. */
internal fun arFailureText(e: Exception): String {
    val detail = e.message?.takeIf { it.isNotBlank() }?.take(140)
    return "Google Play Services for AR reported an internal error on this device (" +
        (detail ?: e.javaClass.simpleName) + "). This usually means AR cannot run here; the 3D viewer shows the same model."
}
