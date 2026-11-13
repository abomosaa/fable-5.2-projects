package dev.pocket3d.data

import dev.pocket3d.core.net.ApiErrorEnvelope
import dev.pocket3d.core.net.ArtifactInfo
import dev.pocket3d.core.net.FileUploadResponse
import dev.pocket3d.core.net.HelloResponse
import dev.pocket3d.core.net.JobPollResponse
import dev.pocket3d.core.net.JobSubmitRequest
import dev.pocket3d.core.net.PairRequest
import dev.pocket3d.core.net.PairResponse
import dev.pocket3d.core.net.PairingInfo
import dev.pocket3d.core.net.ProtocolJson
import dev.pocket3d.core.net.RemoteJob
import dev.pocket3d.core.net.SessionPutRequest
import dev.pocket3d.core.net.SessionStatus
import dev.pocket3d.core.net.StatusResponse
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.ConnectionSpec
import okhttp3.Dispatcher
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.BufferedSink
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.net.Socket
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.X509ExtendedTrustManager
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** The server presented a certificate other than the pinned one. */
class PinMismatchException(message: String) : CertificateException(message)

/**
 * Trusts exactly one certificate: the leaf whose DER encoding has the pinned SHA-256
 * fingerprint. No certificate authorities, no host names, no fallback — the companion's
 * certificate is self-signed and its fingerprint comes from the pairing QR code.
 */
internal class PinnedCertificateTrustManager(fingerprintSha256: String) : X509ExtendedTrustManager() {
    private val pin: ByteArray

    init {
        val hex = PairingInfo.normalizeFingerprint(fingerprintSha256)
            ?: throw IllegalArgumentException("the certificate fingerprint must be 64 hex characters")
        pin = ByteArray(32) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }

    fun matches(cert: java.security.cert.Certificate?): Boolean {
        if (cert == null) return false
        val digest = MessageDigest.getInstance("SHA-256").digest(cert.encoded)
        return MessageDigest.isEqual(digest, pin)
    }

    private fun check(chain: Array<out X509Certificate>?) {
        if (chain == null || chain.isEmpty() || !matches(chain[0])) {
            throw PinMismatchException("the server's certificate does not match the paired companion")
        }
    }

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = check(chain)
    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) = check(chain)
    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) = check(chain)

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) =
        throw CertificateException("client certificates are not used")
    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) =
        throw CertificateException("client certificates are not used")
    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) =
        throw CertificateException("client certificates are not used")

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

/**
 * HTTPS client for one companion address. TLS only, certificate pinned by SHA-256 of the
 * server certificate (DER); the bearer token is sent in the `Authorization` header and never
 * logged or put into exception messages.
 *
 * @param baseUrl `https://<host>:<port>` — any other scheme is rejected
 * @param token bearer token, or null for the two unauthenticated calls (hello, pair)
 */
class CompanionClient(
    baseUrl: String,
    fingerprintSha256: String,
    private val token: String?,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val timeouts: Timeouts = Timeouts(),
    /** Upper bound of one upload request body; the protocol allows any chunking. */
    private val chunkBytes: Int = MAX_CHUNK_BYTES,
) : CompanionApi {

    data class Timeouts(val connectMs: Long = 6_000, val readMs: Long = 20_000, val writeMs: Long = 30_000)

    private val base: HttpUrl
    private val http: OkHttpClient
    private val longPollHttp: OkHttpClient

    init {
        require(chunkBytes in 1..MAX_CHUNK_BYTES) { "chunkBytes must be 1..$MAX_CHUNK_BYTES" }
        val url = try { baseUrl.toHttpUrl() } catch (e: IllegalArgumentException) {
            throw IllegalArgumentException("invalid companion address")
        }
        require(url.isHttps) { "the companion is only ever contacted over HTTPS" }
        base = url
        val trust = PinnedCertificateTrustManager(fingerprintSha256)
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
        http = OkHttpClient.Builder()
            .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS))          // TLS 1.2+, never cleartext
            .sslSocketFactory(ssl.socketFactory, trust)
            // Host names mean nothing for a self-signed LAN certificate: identity is the pin.
            .hostnameVerifier { _, session ->
                try { trust.matches(session.peerCertificates.firstOrNull()) } catch (_: Exception) { false }
            }
            .protocols(listOf(Protocol.HTTP_1_1))
            .dispatcher(Dispatcher().apply { maxRequests = 32; maxRequestsPerHost = 16 })
            .connectTimeout(timeouts.connectMs, TimeUnit.MILLISECONDS)
            .readTimeout(timeouts.readMs, TimeUnit.MILLISECONDS)
            .writeTimeout(timeouts.writeMs, TimeUnit.MILLISECONDS)
            .followRedirects(false).followSslRedirects(false)
            .build()
        longPollHttp = http.newBuilder()
            .readTimeout(timeouts.readMs + MAX_WAIT_SECONDS * 1000L, TimeUnit.MILLISECONDS).build()
    }

    /** Releases sockets and threads. The client must not be used afterwards. */
    fun close() {
        http.dispatcher.cancelAll()
        // Closing a TLS socket writes a close_notify record, i.e. it is network I/O: callers may be
        // on the main thread (pairing UI), where Android forbids that.
        Thread({
            try { http.connectionPool.evictAll() } catch (_: Exception) { }
            http.dispatcher.executorService.shutdown()
        }, "companion-client-close").apply { isDaemon = true }.start()
    }

    override fun toString(): String = "CompanionClient(${base.host}:${base.port})"   // never the token

    // =========================================================================================
    // plumbing
    // =========================================================================================
    private fun url(path: String, query: Map<String, String> = emptyMap()): HttpUrl {
        val b = base.newBuilder().encodedPath(path)
        for ((k, v) in query) b.addQueryParameter(k, v)
        return b.build()
    }

    private fun builder(url: HttpUrl): Request.Builder {
        val b = Request.Builder().url(url).header("Accept", "application/json")
        if (token != null) b.header("Authorization", "Bearer $token")
        return b
    }

    private fun <T> jsonBody(serializer: kotlinx.serialization.SerializationStrategy<T>, value: T): RequestBody =
        ProtocolJson.encodeToString(serializer, value).toRequestBody(JSON)

    /** Runs the call on OkHttp's threads; cancelling the coroutine cancels the HTTP call. */
    private suspend fun <T> exec(request: Request, client: OkHttpClient = http, handle: (Response) -> T): T =
        suspendCancellableCoroutine { cont ->
            val call = client.newCall(request)
            cont.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    cont.resumeWithException(mapFailure(e))
                }

                override fun onResponse(call: Call, response: Response) {
                    val result = try {
                        response.use(handle)
                    } catch (e: CompanionException) {
                        cont.resumeWithException(e); return
                    } catch (e: IOException) {
                        cont.resumeWithException(mapFailure(e)); return
                    } catch (e: Exception) {
                        cont.resumeWithException(CompanionException(CompanionException.Kind.PROTOCOL, "bad_response",
                            "The companion sent an answer this app does not understand.", cause = e)); return
                    }
                    cont.resume(result)
                }
            })
        }

    private fun mapFailure(e: IOException): CompanionException {
        if (e is CompanionException) return e
        var c: Throwable? = e
        var depth = 0
        while (c != null && depth < 8) {
            if (c is PinMismatchException) {
                return CompanionException(CompanionException.Kind.FINGERPRINT_MISMATCH, "fingerprint_mismatch",
                    "The computer at ${base.host} presented a different security certificate than the paired " +
                        "companion. The connection was refused.", cause = e)
            }
            c = c.cause; depth++
        }
        if (e is javax.net.ssl.SSLPeerUnverifiedException) {
            return CompanionException(CompanionException.Kind.FINGERPRINT_MISMATCH, "fingerprint_mismatch",
                "The computer at ${base.host} could not prove it is the paired companion. The connection was refused.",
                cause = e)
        }
        val why = when (e) {
            is java.net.SocketTimeoutException -> "no answer in time"
            is java.net.UnknownHostException -> "address not found"
            is java.net.ConnectException, is java.net.NoRouteToHostException -> "connection refused or no route"
            is javax.net.ssl.SSLException -> "secure connection failed"
            else -> "connection lost"
        }
        return CompanionException.unreachable("Companion unreachable at ${base.host}:${base.port} ($why).", e)
    }

    private fun errorFrom(resp: Response): CompanionException {
        val status = resp.code
        val text = try { resp.peekBody(64 * 1024).string() } catch (_: IOException) { "" }
        var code = ""
        var message = ""
        var received: Long? = null
        var retryAfter: Int? = resp.header("Retry-After")?.trim()?.toIntOrNull()
        try {
            val env = wire.decodeFromString(ApiErrorEnvelope.serializer(), text)
            val obj = wire.parseToJsonElement(text) as? JsonObject
            if (obj != null && obj.containsKey("error")) {
                code = env.error.code; message = env.error.message; received = env.received
                retryAfter = retryAfter ?: (obj["retry_after"] as? kotlinx.serialization.json.JsonPrimitive)?.intOrNull
            }
        } catch (_: Exception) {
        }
        if (code.isEmpty()) code = if (status == 401) "unauthorized" else "http_$status"
        if (message.isEmpty()) message = "The companion answered with HTTP $status."
        val kind = if (status == 401) CompanionException.Kind.UNAUTHORIZED else CompanionException.Kind.API
        return CompanionException(kind, code, message, status, received, retryAfter)
    }

    private fun <T> decode(serializer: DeserializationStrategy<T>, resp: Response): T {
        if (!resp.isSuccessful) throw errorFrom(resp)
        val body = resp.body ?: throw protocolError(null)
        val text = body.source().let { src ->
            if (src.request(MAX_JSON_BYTES + 1)) throw protocolError(null)
            src.readUtf8()
        }
        return try {
            wire.decodeFromString(serializer, text)
        } catch (e: SerializationException) {
            throw protocolError(e)
        } catch (e: IllegalArgumentException) {
            throw protocolError(e)
        }
    }

    private fun protocolError(cause: Throwable?) = CompanionException(CompanionException.Kind.PROTOCOL, "bad_response",
        "The companion sent an answer this app does not understand.", cause = cause)

    private fun requireSessionId(id: String) = require(Ids.UUID4.matches(id)) { "session id must be a lower-case UUIDv4" }
    private fun requireJobId(id: String) = require(Ids.UUID4.matches(id)) { "job id must be a lower-case UUIDv4" }

    // =========================================================================================
    // hello / pair / status
    // =========================================================================================
    override suspend fun hello(): HelloResponse =
        exec(builder(url("/v1/hello")).get().build()) { decode(HelloResponse.serializer(), it) }

    override suspend fun pair(code: String, deviceName: String, deviceId: String?): PairResponse {
        val body = jsonBody(PairRequest.serializer(), PairRequest(code, deviceName, deviceId))
        // Never send an old token along with a pairing request.
        val req = Request.Builder().url(url("/v1/pair")).header("Accept", "application/json").post(body).build()
        return exec(req) { decode(PairResponse.serializer(), it) }
    }

    override suspend fun status(): StatusResponse =
        exec(builder(url("/v1/status")).get().build()) { decode(StatusResponse.serializer(), it) }

    // =========================================================================================
    // sessions + upload
    // =========================================================================================
    override suspend fun putSession(sessionId: String, body: SessionPutRequest): SessionStatus {
        requireSessionId(sessionId)
        val req = builder(url("/v1/sessions/$sessionId")).put(jsonBody(SessionPutRequest.serializer(), body)).build()
        return exec(req) { decode(SessionStatus.serializer(), it) }
    }

    override suspend fun getSession(sessionId: String): SessionStatus {
        requireSessionId(sessionId)
        return exec(builder(url("/v1/sessions/$sessionId")).get().build()) { decode(SessionStatus.serializer(), it) }
    }

    override suspend fun deleteSession(sessionId: String): Boolean {
        requireSessionId(sessionId)
        return exec(builder(url("/v1/sessions/$sessionId")).delete().build()) { resp ->
            when {
                resp.isSuccessful -> true
                resp.code == 404 -> false
                else -> throw errorFrom(resp)
            }
        }
    }

    /** Streams `length` bytes of a file starting at `offset`, without loading them into memory. */
    private class FileSliceBody(private val file: File, private val offset: Long, private val length: Long,
                                private val onBytes: (Long) -> Unit) : RequestBody() {
        override fun contentType() = OCTET
        override fun contentLength() = length
        override fun writeTo(sink: BufferedSink) {
            RandomAccessFile(file, "r").use { raf ->
                raf.seek(offset)
                val buf = ByteArray(64 * 1024)
                var left = length
                while (left > 0) {
                    val n = raf.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
                    if (n < 0) throw IOException("the photo file is shorter than expected")
                    sink.write(buf, 0, n)
                    left -= n
                    onBytes(offset + (length - left))
                }
            }
        }
    }

    private suspend fun remoteReceived(sessionId: String, fileId: String): SessionStatus.FileStatus {
        val st = getSession(sessionId)
        return st.files.firstOrNull { it.id == fileId }
            ?: throw CompanionException(CompanionException.Kind.API, "not_found",
                "The companion's copy of this capture no longer lists the photo.", 404)
    }

    override suspend fun uploadFile(sessionId: String, fileId: String, file: File, size: Long, sha256: String,
                                    startOffset: Long, onProgress: (Long) -> Unit) {
        requireSessionId(sessionId)
        require(Ids.FRAME_ID.matches(fileId)) { "invalid file id" }
        if (!file.isFile || file.length() != size) {
            throw CompanionException(CompanionException.Kind.INTEGRITY, "local_file_changed",
                "A photo file on the phone is missing or changed size since it was captured.")
        }
        var offset = startOffset.coerceIn(0, size)
        var checksumFailures = 0
        var brokenWithoutProgress = 0
        var resyncs = 0
        val target = url("/v1/sessions/$sessionId/files/$fileId")
        while (true) {
            val length = minOf(chunkBytes.toLong(), size - offset)
            val body = FileSliceBody(file, offset, length, onProgress)
            val req = builder(target).header("Upload-Offset", offset.toString()).put(body).build()
            val sentFrom = offset
            val resp: FileUploadResponse = try {
                exec(req) { decode(FileUploadResponse.serializer(), it) }
            } catch (e: CompanionException) {
                when {
                    e.kind == CompanionException.Kind.API && e.code == "offset_mismatch" -> {
                        // The companion has a different number of bytes than we assumed.
                        if (++resyncs > MAX_RESYNCS) throw e
                        offset = (e.received ?: remoteReceived(sessionId, fileId).received).coerceIn(0, size)
                        onProgress(offset)
                        continue
                    }
                    e.kind == CompanionException.Kind.API && e.code == "checksum_mismatch" -> {
                        // The companion threw the file away. Find out which side is wrong.
                        val local = withContext(io) { StorageFiles.sha256(file) }
                        if (!local.sha256.equals(sha256, ignoreCase = true) || local.size != size) {
                            throw CompanionException(CompanionException.Kind.INTEGRITY, "local_file_changed",
                                "A photo file on the phone no longer matches its checksum from capture time; " +
                                    "it may be damaged.", cause = e)
                        }
                        if (++checksumFailures >= MAX_CHECKSUM_ATTEMPTS) {
                            throw CompanionException(CompanionException.Kind.API, "checksum_mismatch",
                                "A photo arrived damaged on the companion $checksumFailures times in a row " +
                                    "(checksum mismatch). Check the Wi-Fi connection and retry.", e.httpStatus, cause = e)
                        }
                        offset = 0
                        onProgress(0)
                        continue
                    }
                    e.kind == CompanionException.Kind.UNREACHABLE -> {
                        // Broken mid-request (or the companion answered early and the stack reports
                        // a reset): ask how much it has before sending anything again.
                        val remote = remoteReceived(sessionId, fileId)   // throws UNREACHABLE if still down
                        if (remote.complete) { onProgress(size); return }
                        val now = remote.received.coerceIn(0, size)
                        brokenWithoutProgress = if (now > sentFrom) 0 else brokenWithoutProgress + 1
                        if (brokenWithoutProgress >= MAX_BROKEN_WITHOUT_PROGRESS) throw e
                        offset = now
                        onProgress(offset)
                        continue
                    }
                    else -> throw e   // 413 / 422 unsupported_format / 507 / 404 / 401 …: the caller decides
                }
            }
            if (resp.complete) {
                if (resp.received != size) throw protocolError(null)
                onProgress(size)
                return
            }
            if (resp.received <= sentFrom || resp.received > size) {
                // No progress according to the companion — re-synchronise instead of looping blindly.
                if (++resyncs > MAX_RESYNCS) throw protocolError(null)
                offset = remoteReceived(sessionId, fileId).received.coerceIn(0, size)
            } else {
                offset = resp.received
            }
            if (offset >= size) {
                // All bytes are there but not confirmed complete: verification is the companion's
                // word, so ask once more rather than assume.
                val remote = remoteReceived(sessionId, fileId)
                if (remote.complete) { onProgress(size); return }
                if (++resyncs > MAX_RESYNCS) throw protocolError(null)
                offset = remote.received.coerceIn(0, size)
            }
            onProgress(offset)
        }
    }

    // =========================================================================================
    // jobs
    // =========================================================================================
    override suspend fun submitJob(jobId: String, body: JobSubmitRequest): RemoteJob {
        requireJobId(jobId)
        val req = builder(url("/v1/jobs/$jobId")).put(jsonBody(JobSubmitRequest.serializer(), body)).build()
        return exec(req) { decode(RemoteJob.serializer(), it) }
    }

    override suspend fun pollJob(jobId: String, since: Long, waitSeconds: Int): JobPollResponse {
        requireJobId(jobId)
        val wait = waitSeconds.coerceIn(0, MAX_WAIT_SECONDS)
        val u = url("/v1/jobs/$jobId", mapOf("since" to since.coerceAtLeast(0).toString(), "wait" to wait.toString()))
        return exec(builder(u).get().build(), if (wait > 0) longPollHttp else http) {
            decode(JobPollResponse.serializer(), it)
        }
    }

    override suspend fun cancelJob(jobId: String): RemoteJob {
        requireJobId(jobId)
        val req = builder(url("/v1/jobs/$jobId/cancel")).post(EMPTY).build()
        return exec(req) { decode(RemoteJob.serializer(), it) }
    }

    override suspend fun retryJob(jobId: String): RemoteJob {
        requireJobId(jobId)
        val req = builder(url("/v1/jobs/$jobId/retry")).post(EMPTY).build()
        return exec(req) { decode(RemoteJob.serializer(), it) }
    }

    override suspend fun deleteJob(jobId: String): Boolean {
        requireJobId(jobId)
        return exec(builder(url("/v1/jobs/$jobId")).delete().build()) { resp ->
            when {
                resp.isSuccessful -> true
                resp.code == 404 -> false
                else -> throw errorFrom(resp)
            }
        }
    }

    // =========================================================================================
    // artifacts
    // =========================================================================================
    override suspend fun downloadArtifact(jobId: String, artifact: ArtifactInfo, dest: File, onProgress: (Long) -> Unit) {
        requireJobId(jobId)
        require(ARTIFACT_NAME.matches(artifact.name)) { "invalid artifact name" }
        val expectedSha = artifact.sha256.lowercase()
        if (!Ids.SHA256.matches(expectedSha) || artifact.size <= 0) {
            throw CompanionException(CompanionException.Kind.PROTOCOL, "bad_response",
                "The companion did not announce a size and checksum for ${artifact.name}.")
        }
        val part = File(dest.absoluteFile.parentFile, dest.name + ".part")
        withContext(io) {
            part.parentFile?.mkdirs()
            if (part.length() > artifact.size) part.delete()   // not a prefix of this artifact
        }
        var restarts = 0
        while (true) {
            val have = withContext(io) { if (part.isFile) part.length() else 0L }
            if (have < artifact.size) {
                val b = builder(url("/v1/jobs/$jobId/artifacts/${artifact.name}")).header("Accept", "*/*")
                    .header("Accept-Encoding", "identity")
                if (have > 0) {
                    // If-Range: resume only if the artifact is still the one this prefix came from.
                    b.header("Range", "bytes=$have-").header("If-Range", "\"$expectedSha\"")
                }
                val restart = exec(b.get().build()) { resp ->
                    when {
                        resp.code == 416 -> { part.delete(); true }
                        !resp.isSuccessful -> throw errorFrom(resp)
                        else -> {
                            val append = resp.code == 206
                            if (append && !contentRangeStartsAt(resp.header("Content-Range"), have)) throw protocolError(null)
                            val body = resp.body ?: throw protocolError(null)
                            var total = if (append) have else 0L
                            FileOutputStream(part, append).use { out ->
                                val src = body.source()
                                val buf = ByteArray(64 * 1024)
                                while (true) {
                                    val n = src.read(buf)
                                    if (n < 0) break
                                    total += n
                                    if (total > artifact.size) throw CompanionException(CompanionException.Kind.INTEGRITY,
                                        "size_mismatch", "${artifact.name} is larger than the companion announced.")
                                    out.write(buf, 0, n)
                                    onProgress(total)
                                }
                                out.flush()
                                out.fd.sync()
                            }
                            false
                        }
                    }
                }
                if (restart) {
                    if (++restarts > MAX_RESYNCS) throw protocolError(null)
                    continue
                }
            }
            // Verify the whole file as it is on disk — not just the bytes of this request.
            val digest = withContext(io) { StorageFiles.sha256(part) }
            if (digest.size < artifact.size) {
                // The connection ended early without an error; resume from what arrived.
                if (++restarts > MAX_RESYNCS) throw CompanionException.unreachable(
                    "The download of ${artifact.name} keeps ending early.")
                continue
            }
            if (digest.size != artifact.size || digest.sha256 != expectedSha) {
                withContext(io) { part.delete() }
                throw CompanionException(CompanionException.Kind.INTEGRITY, "checksum_mismatch",
                    "${artifact.name} arrived damaged (size or SHA-256 does not match what the companion announced).")
            }
            withContext(io) {
                StorageFiles.moveAtomic(part, dest)
                dest.parentFile?.let { StorageFiles.fsyncDir(it) }
            }
            onProgress(artifact.size)
            return
        }
    }

    private fun contentRangeStartsAt(header: String?, offset: Long): Boolean {
        val m = CONTENT_RANGE.matchEntire(header?.trim() ?: return false) ?: return false
        return m.groupValues[1].toLongOrNull() == offset
    }

    companion object {
        /** The largest request body this client sends for an upload. */
        const val MAX_CHUNK_BYTES = 4 * 1024 * 1024
        const val MAX_WAIT_SECONDS = 30
        private const val MAX_JSON_BYTES = 32L * 1024 * 1024
        private const val MAX_CHECKSUM_ATTEMPTS = 3
        private const val MAX_BROKEN_WITHOUT_PROGRESS = 3
        private const val MAX_RESYNCS = 5
        private val JSON = "application/json; charset=utf-8".toMediaType()
        private val OCTET = "application/octet-stream".toMediaType()
        private val EMPTY = ByteArray(0).toRequestBody(null)
        private val ARTIFACT_NAME = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
        private val CONTENT_RANGE = Regex("^bytes (\\d+)-(\\d+)/(\\d+|\\*)$")

        /**
         * The protocol's JSON, plus: a JSON `null` for a field this app models as non-null with a
         * default (e.g. `stage_index` of a queued job, `progress` of a log event) decodes to that
         * default instead of failing the whole response.
         */
        internal val wire: Json = Json(ProtocolJson) { coerceInputValues = true }
    }
}
