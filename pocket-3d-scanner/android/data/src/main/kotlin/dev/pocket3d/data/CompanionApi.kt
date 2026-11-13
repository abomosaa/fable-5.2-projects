package dev.pocket3d.data

import dev.pocket3d.core.net.ArtifactInfo
import dev.pocket3d.core.net.HelloResponse
import dev.pocket3d.core.net.JobPollResponse
import dev.pocket3d.core.net.JobSubmitRequest
import dev.pocket3d.core.net.PairResponse
import dev.pocket3d.core.net.RemoteJob
import dev.pocket3d.core.net.SessionPutRequest
import dev.pocket3d.core.net.SessionStatus
import dev.pocket3d.core.net.StatusResponse
import java.io.File
import java.io.IOException

/**
 * Typed failure of a companion call.
 *
 * [kind] separates the cases callers must treat differently: the companion cannot be reached
 * (keep waiting), it answered but rejects this phone (pair again), someone else answered
 * (refuse), it answered with a protocol error (see [code] / [httpStatus]), or what was
 * transferred does not verify.
 */
class CompanionException(
    val kind: Kind,
    val code: String,
    override val message: String,
    val httpStatus: Int? = null,
    /** `received` of an upload error envelope (offset to resume from), when present. */
    val received: Long? = null,
    val retryAfterSeconds: Int? = null,
    cause: Throwable? = null,
) : IOException(message, cause) {

    enum class Kind {
        /** No answer: wrong network, companion not running, timeout, connection dropped. */
        UNREACHABLE,
        /** The certificate presented is not the pinned one — possibly an impersonator. */
        FINGERPRINT_MISMATCH,
        /** 401: the companion does not (any longer) accept this phone's token. */
        UNAUTHORIZED,
        /** The companion answered with an error from the protocol's error list. */
        API,
        /** The answer could not be understood (not the companion protocol). */
        PROTOCOL,
        /** Transferred bytes do not match the announced size / SHA-256. */
        INTEGRITY,
    }

    /** True if simply trying again later can succeed without the user doing anything. */
    val isTransient: Boolean
        get() = when (kind) {
            Kind.UNREACHABLE -> true
            Kind.API -> httpStatus != null && (httpStatus == 408 || httpStatus == 429 ||
                (httpStatus >= 500 && httpStatus != 507))
            else -> false
        }

    val isNotFound: Boolean get() = kind == Kind.API && httpStatus == 404

    companion object {
        fun unreachable(message: String, cause: Throwable? = null) =
            CompanionException(Kind.UNREACHABLE, "unreachable", message, cause = cause)
    }
}

/**
 * The companion protocol (docs/companion-protocol.md) as suspend functions. All of them throw
 * [CompanionException] and nothing else for network / protocol problems, and are cancellable.
 * Implemented by [CompanionClient]; tests script a fake.
 */
interface CompanionApi {
    suspend fun hello(): HelloResponse
    suspend fun pair(code: String, deviceName: String, deviceId: String?): PairResponse
    suspend fun status(): StatusResponse

    suspend fun putSession(sessionId: String, body: SessionPutRequest): SessionStatus
    suspend fun getSession(sessionId: String): SessionStatus
    /** @return false if the companion had no such session (nothing to delete). */
    suspend fun deleteSession(sessionId: String): Boolean

    /**
     * Uploads [file] (resumable). Starts at [startOffset] — the `received` the companion last
     * reported — and re-synchronises with the companion whenever it disagrees or the connection
     * breaks. Returns only when the companion confirmed the complete, checksum-verified file.
     * [onProgress] receives the number of bytes of this file the companion has (approximately,
     * while a request is in flight); it may be called from any thread.
     */
    suspend fun uploadFile(sessionId: String, fileId: String, file: File, size: Long, sha256: String,
                           startOffset: Long, onProgress: (Long) -> Unit = {})

    suspend fun submitJob(jobId: String, body: JobSubmitRequest): RemoteJob
    suspend fun pollJob(jobId: String, since: Long, waitSeconds: Int): JobPollResponse
    suspend fun cancelJob(jobId: String): RemoteJob
    suspend fun retryJob(jobId: String): RemoteJob
    /** @return false if the companion had no such job. */
    suspend fun deleteJob(jobId: String): Boolean

    /**
     * Downloads an artifact to [dest]: bytes go to `<dest>.part` (resumed with `Range` if it
     * already exists), and only after size and SHA-256 match [artifact] is the file moved to
     * [dest]. A mismatch deletes the partial file and throws [CompanionException.Kind.INTEGRITY].
     */
    suspend fun downloadArtifact(jobId: String, artifact: ArtifactInfo, dest: File, onProgress: (Long) -> Unit = {})
}
