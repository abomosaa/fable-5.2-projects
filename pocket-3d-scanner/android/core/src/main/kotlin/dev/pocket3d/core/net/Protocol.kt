package dev.pocket3d.core.net

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Wire types of the companion protocol v1 (docs/companion-protocol.md). Unknown fields are
 * ignored on decode so a newer companion keeps working with this app.
 */
val ProtocolJson: Json = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
    explicitNulls = false
    isLenient = false
    // The companion sends explicit nulls for fields that do not apply to an event (e.g. the
    // progress of a log line); fall back to the declared defaults instead of failing the poll.
    coerceInputValues = true
}

@Serializable data class ApiError(val code: String = "server_error", val message: String = "")
@Serializable data class ApiErrorEnvelope(val error: ApiError = ApiError(), val received: Long? = null)

@Serializable
data class HelloResponse(
    val product: String = "", val api: Int = 0, val version: String = "",
    @SerialName("server_id") val serverId: String = "", @SerialName("server_name") val serverName: String = "",
)

@Serializable
data class PairRequest(val code: String, @SerialName("device_name") val deviceName: String,
                       @SerialName("device_id") val deviceId: String? = null)

@Serializable
data class PairResponse(val token: String, @SerialName("device_id") val deviceId: String,
                        @SerialName("server_id") val serverId: String = "",
                        @SerialName("server_name") val serverName: String = "")

@Serializable
data class StatusResponse(
    val version: String = "", val api: Int = 1,
    @SerialName("server_id") val serverId: String = "", @SerialName("server_name") val serverName: String = "",
    val hardware: Hardware = Hardware(), val resources: Resources = Resources(), val queue: Queue = Queue(),
    val limits: Limits = Limits(), val presets: List<PresetInfo> = emptyList(),
) {
    @Serializable data class Hardware(@SerialName("cpu_model") val cpuModel: String = "",
                                      @SerialName("cpu_threads") val cpuThreads: Int = 0,
                                      @SerialName("mem_total_mb") val memTotalMb: Long = 0, val gpu: String? = null)
    @Serializable data class Resources(@SerialName("max_parallel_jobs") val maxParallelJobs: Int = 1,
                                       @SerialName("job_threads") val jobThreads: Int = 0,
                                       @SerialName("job_memory_mb") val jobMemoryMb: Long = 0,
                                       @SerialName("disk_free_mb") val diskFreeMb: Long = 0)
    @Serializable data class Queue(val running: Int = 0, val queued: Int = 0)
    @Serializable data class Limits(
        @SerialName("max_images") val maxImages: Int = 400, @SerialName("min_images") val minImages: Int = 3,
        @SerialName("max_image_bytes") val maxImageBytes: Long = 64L shl 20,
        @SerialName("max_image_pixels") val maxImagePixels: Long = 80_000_000,
        @SerialName("min_image_side") val minImageSide: Int = 320,
        @SerialName("max_session_bytes") val maxSessionBytes: Long = 8L shl 30,
        val formats: List<String> = listOf("jpeg", "png", "webp", "heic"),
    )
}

@Serializable data class PresetInfo(val id: String, val label: String = id, val description: String = "")

@Serializable
data class SessionFileSpec(val id: String, val name: String, val size: Long, val sha256: String)

@Serializable
data class SessionPutRequest(val name: String, val capture: JsonElement, val files: List<SessionFileSpec>)

@Serializable
data class SessionStatus(
    @SerialName("session_id") val sessionId: String = "", val name: String = "",
    @SerialName("total_bytes") val totalBytes: Long = 0, @SerialName("received_bytes") val receivedBytes: Long = 0,
    val complete: Boolean = false, val files: List<FileStatus> = emptyList(),
) {
    @Serializable data class FileStatus(val id: String, val size: Long = 0, val received: Long = 0,
                                        val complete: Boolean = false, val error: String? = null)
}

@Serializable
data class FileUploadResponse(val id: String = "", val received: Long = 0, val complete: Boolean = false)

@Serializable
data class JobSubmitRequest(@SerialName("session_id") val sessionId: String, val preset: String,
                            val settings: JsonObject = JsonObject(emptyMap()))

/** Remote job states exactly as reported by the companion. */
object RemoteState {
    const val QUEUED = "queued"; const val RUNNING = "running"; const val CANCELLING = "cancelling"
    const val SUCCEEDED = "succeeded"; const val FAILED = "failed"; const val CANCELLED = "cancelled"
    const val INTERRUPTED = "interrupted"
    val TERMINAL = setOf(SUCCEEDED, FAILED, CANCELLED, INTERRUPTED)
}

@Serializable
data class JobError(val code: String = "", val message: String = "", val guidance: List<String> = emptyList())

@Serializable
data class ArtifactInfo(val name: String, val size: Long = 0, val sha256: String = "", val kind: String = "")

@Serializable
data class RemoteJob(
    @SerialName("job_id") val jobId: String = "", @SerialName("session_id") val sessionId: String = "",
    val preset: String = "", val state: String = RemoteState.QUEUED, val attempt: Int = 1,
    @SerialName("queue_position") val queuePosition: Int = 0,
    @SerialName("created_at") val createdAt: Double? = null, @SerialName("started_at") val startedAt: Double? = null,
    @SerialName("finished_at") val finishedAt: Double? = null,
    val stage: String? = null, @SerialName("stage_index") val stageIndex: Int = 0,
    @SerialName("stage_count") val stageCount: Int = 0,
    @SerialName("stage_progress") val stageProgress: Double = 0.0,
    @SerialName("overall_progress") val overallProgress: Double = 0.0,
    val message: String = "", val error: JobError? = null,
    val diagnostics: JsonObject = JsonObject(emptyMap()), val artifacts: List<ArtifactInfo> = emptyList(),
)

@Serializable
data class JobEvent(val seq: Long = 0, val t: Double = 0.0, val type: String = "", val stage: String? = null,
                    val progress: Double = 0.0, val overall: Double = 0.0, val message: String = "",
                    val data: JsonObject? = null)

@Serializable
data class JobPollResponse(val job: RemoteJob = RemoteJob(), val events: List<JobEvent> = emptyList(),
                           @SerialName("last_seq") val lastSeq: Long = 0)

/** Parsed `pocket3d://pair?...` URI shown by the companion (QR code or typed). */
data class PairingInfo(val hosts: List<String>, val port: Int, val fingerprintSha256: String, val code: String) {
    companion object {
        /** Returns null if [uri] is not a well-formed pairing URI. */
        fun parse(uri: String): PairingInfo? {
            val u = uri.trim()
            val prefix = "pocket3d://pair?"
            if (!u.startsWith(prefix, ignoreCase = true)) return null
            val params = u.substring(prefix.length).split('&').mapNotNull {
                val i = it.indexOf('='); if (i <= 0) null else it.substring(0, i).lowercase() to decode(it.substring(i + 1))
            }.toMap()
            if (params["v"] != "1") return null
            val hosts = params["host"]?.split(',')?.map { it.trim() }?.filter { isValidHost(it) } ?: return null
            val port = params["port"]?.toIntOrNull()?.takeIf { it in 1..65535 } ?: return null
            val fp = normalizeFingerprint(params["fp"] ?: return null) ?: return null
            val code = params["code"]?.uppercase()?.takeIf { it.matches(Regex("^[2-9A-HJ-NP-Z]{8}$")) } ?: return null
            if (hosts.isEmpty()) return null
            return PairingInfo(hosts, port, fp, code)
        }

        /** Accepts hex with optional separators; returns 64 lower-case hex chars or null. */
        fun normalizeFingerprint(s: String): String? {
            val hex = s.filter { it.isLetterOrDigit() }.lowercase()
            return hex.takeIf { it.length == 64 && it.all { c -> c in '0'..'9' || c in 'a'..'f' } }
        }

        fun isValidHost(h: String): Boolean =
            h.isNotEmpty() && h.length <= 253 && h.all { it.isLetterOrDigit() || it == '.' || it == '-' || it == ':' }

        private fun decode(s: String): String = try {
            java.net.URLDecoder.decode(s, "UTF-8")
        } catch (e: IllegalArgumentException) { s }
    }
}
