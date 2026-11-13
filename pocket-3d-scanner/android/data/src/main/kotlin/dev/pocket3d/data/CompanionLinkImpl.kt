package dev.pocket3d.data

import dev.pocket3d.core.net.PairingInfo
import dev.pocket3d.core.services.CompanionLink
import dev.pocket3d.core.services.CompanionState
import dev.pocket3d.core.services.PairResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** The companion the phone is paired with, as the sync engine sees it. */
class PairedCompanion(val serverId: String, val serverName: String, val api: CompanionApi)

/** What the sync engine needs from the pairing layer. Implemented by [CompanionLinkImpl]. */
interface CompanionGateway {
    /** The paired companion at the address currently in use, or null when not paired. */
    fun current(): PairedCompanion?
    /**
     * Re-checks all known addresses of the paired companion (it may have got a new IP).
     * Returns true if it answered and still is the paired companion.
     */
    suspend fun probe(): Boolean
}

/** Creates the HTTP client for one address. `token == null` → only hello/pair will be called. */
fun interface CompanionApiFactory {
    fun create(baseUrl: String, fingerprintSha256: String, token: String?, quick: Boolean): CompanionApi
}

/**
 * Pairing and reachability. All trust decisions are made by the pinned-certificate client: this
 * class only decides which address to talk to and turns failures into text a person can act on.
 */
class CompanionLinkImpl(
    private val pairings: PairingStore,
    private val apiFactory: CompanionApiFactory,
    /** Called after the pairing changed or the companion became reachable (wakes the sync engine). */
    private var onChanged: () -> Unit = {},
) : CompanionLink, CompanionGateway {

    private val _state = MutableStateFlow(CompanionState())
    override val state: StateFlow<CompanionState> = _state.asStateFlow()

    private val mutex = Mutex()
    private val cacheLock = Any()
    private var record: PairingRecord? = null
    private var cached: PairedCompanion? = null
    private var cachedKey: String? = null

    init {
        val r = pairings.load()
        record = r
        if (r != null) {
            _state.value = CompanionState(paired = true, serverId = r.serverId, serverName = r.serverName,
                baseUrl = r.baseUrls.firstOrNull(), fingerprintSha256 = r.fingerprintSha256)
        }
    }

    fun setOnChanged(listener: () -> Unit) { onChanged = listener }

    override fun current(): PairedCompanion? = synchronized(cacheLock) {
        val r = record ?: return null
        val url = r.baseUrls.firstOrNull() ?: return null
        val key = r.serverId + "|" + url + "|" + r.fingerprintSha256 + "|" + r.token.hashCode()
        if (cachedKey != key) {
            (cached?.api as? CompanionClient)?.close()
            cached = PairedCompanion(r.serverId, r.serverName, apiFactory.create(url, r.fingerprintSha256, r.token, false))
            cachedKey = key
        }
        cached
    }

    private fun setRecord(r: PairingRecord?) = synchronized(cacheLock) {
        record = r
        if (r == null) {
            (cached?.api as? CompanionClient)?.close()
            cached = null; cachedKey = null
        }
    }

    // =========================================================================================
    // pairing
    // =========================================================================================
    override suspend fun pair(info: PairingInfo, deviceName: String): PairResult = mutex.withLock {
        _state.update { it.copy(checking = true) }
        try {
            pairLocked(info, deviceName)
        } finally {
            _state.update { it.copy(checking = false) }
        }
    }

    private suspend fun pairLocked(info: PairingInfo, deviceName: String): PairResult {
        val fingerprint = PairingInfo.normalizeFingerprint(info.fingerprintSha256)
            ?: return PairResult.Failure("The pairing code is damaged (invalid certificate fingerprint). Scan it again.")
        val urls = info.hosts.filter { PairingInfo.isValidHost(it) }.map { baseUrl(it, info.port) }.distinct()
        if (urls.isEmpty()) return PairResult.Failure("The pairing code contains no usable address. Scan it again.")

        var mismatchAt: String? = null
        var foreign: String? = null
        for (url in urls) {
            val api = apiFactory.create(url, fingerprint, null, true)
            try {
                val hello = try {
                    api.hello()
                } catch (e: CompanionException) {
                    when (e.kind) {
                        CompanionException.Kind.FINGERPRINT_MISMATCH -> mismatchAt = mismatchAt ?: url
                        CompanionException.Kind.UNREACHABLE -> Unit
                        else -> foreign = foreign ?: url
                    }
                    continue
                }
                if (hello.product != PRODUCT) { foreign = foreign ?: url; continue }
                if (hello.api != API_VERSION) {
                    return PairResult.Failure("The companion at ${hostOf(url)} speaks protocol version ${hello.api}, " +
                        "this app needs version $API_VERSION. Update the app and the companion to matching versions.")
                }
                // The right computer answered with the right certificate: exchange the code.
                val deviceId = pairings.deviceId()
                val resp = try {
                    api.pair(info.code, deviceName.trim().take(64).ifEmpty { "Android phone" }, deviceId)
                } catch (e: CompanionException) {
                    return PairResult.Failure(pairFailureText(e))
                }
                if (resp.token.isEmpty()) return PairResult.Failure("The companion did not send an access token. Try again.")
                val serverId = resp.serverId.ifEmpty { hello.serverId }
                val serverName = resp.serverName.ifEmpty { hello.serverName }.ifEmpty { "Companion" }
                val newRecord = PairingRecord(serverId = serverId, serverName = serverName,
                    baseUrls = listOf(url) + urls.filter { it != url }, fingerprintSha256 = fingerprint,
                    token = resp.token, deviceId = resp.deviceId.ifEmpty { deviceId })
                pairings.save(newRecord)
                setRecord(newRecord)
                _state.value = CompanionState(paired = true, serverId = serverId, serverName = serverName, baseUrl = url,
                    fingerprintSha256 = fingerprint, reachable = true)
                refreshLocked()
                notifyChanged()
                return PairResult.Success(serverName)
            } finally {
                (api as? CompanionClient)?.close()
            }
        }
        val hosts = info.hosts.joinToString(", ")
        return PairResult.Failure(when {
            mismatchAt != null ->
                "A computer answered at ${hostOf(mismatchAt!!)}, but its security certificate does not match the " +
                    "pairing code. This could be another device at that address — or someone impersonating your " +
                    "companion. Pairing was refused. Scan the code shown by the companion itself again."
            foreign != null ->
                "Something answered at ${hostOf(foreign!!)}, but it is not a Pocket 3D companion."
            else ->
                "Could not reach the companion at $hosts (port ${info.port}). Make sure the phone is on the same " +
                    "Wi-Fi network as the computer and that the companion is running."
        })
    }

    private fun pairFailureText(e: CompanionException): String = when {
        e.code == "pairing_failed" ->
            "Wrong or expired pairing code. The companion shows a fresh code — scan or type that one."
        e.code == "pairing_locked" -> {
            val wait = e.retryAfterSeconds?.let { " for about $it s" } ?: " for a minute"
            "Too many wrong codes: pairing is locked$wait. The companion now shows a new code — use it once the lock ends."
        }
        e.kind == CompanionException.Kind.UNREACHABLE ->
            "The connection to the companion was lost while pairing. Check the Wi-Fi connection and try again."
        e.kind == CompanionException.Kind.FINGERPRINT_MISMATCH -> e.message
        else -> "The companion refused to pair: ${e.message}"
    }

    override suspend fun unpair() = mutex.withLock {
        pairings.clear()
        setRecord(null)
        _state.value = CompanionState()
        notifyChanged()
    }

    // =========================================================================================
    // reachability
    // =========================================================================================
    override suspend fun refresh() {
        mutex.withLock { refreshLocked() }
    }

    override suspend fun probe(): Boolean = mutex.withLock { refreshLocked() }

    private suspend fun refreshLocked(): Boolean {
        val r = record
        if (r == null) {
            _state.value = CompanionState()
            return false
        }
        val wasReachable = _state.value.reachable == true
        _state.update { it.copy(checking = true) }
        var error: String? = null
        var severe: String? = null
        try {
            for (url in r.baseUrls) {
                val isCurrent = url == r.baseUrls.first()
                val api = if (isCurrent) current()?.api ?: continue else apiFactory.create(url, r.fingerprintSha256, r.token, true)
                try {
                    val status = api.status()
                    if (status.serverId.isNotEmpty() && status.serverId != r.serverId) {
                        severe = severe ?: "A different companion answered at ${hostOf(url)}. Pair again to use it."
                        continue
                    }
                    if (!isCurrent) {
                        // The companion moved to another of its addresses: remember it for next time.
                        val moved = r.copy(baseUrls = listOf(url) + r.baseUrls.filter { it != url })
                        pairings.save(moved)
                        setRecord(moved)
                    }
                    _state.update {
                        it.copy(paired = true, serverId = r.serverId,
                            serverName = status.serverName.ifEmpty { r.serverName }, baseUrl = url,
                            fingerprintSha256 = r.fingerprintSha256, reachable = true, status = status,
                            lastError = null, checking = false)
                    }
                    if (!wasReachable || !isCurrent) notifyChanged()
                    return true
                } catch (e: CompanionException) {
                    when (e.kind) {
                        CompanionException.Kind.UNAUTHORIZED -> severe = severe
                            ?: "${r.serverName} no longer accepts this phone (it was removed there). Pair again."
                        CompanionException.Kind.FINGERPRINT_MISMATCH -> severe = severe
                            ?: "The computer at ${hostOf(url)} is not the paired companion (its certificate differs). " +
                            "Nothing was sent to it."
                        CompanionException.Kind.UNREACHABLE -> error = error ?: e.message
                        else -> error = e.message
                    }
                } finally {
                    if (!isCurrent) (api as? CompanionClient)?.close()
                }
            }
            _state.update {
                it.copy(reachable = false, checking = false, lastError = severe ?: error
                    ?: "${r.serverName} is not reachable. Is the phone on the same Wi-Fi network?")
            }
            return false
        } catch (e: CancellationException) {
            _state.update { it.copy(checking = false) }
            throw e
        }
    }

    /**
     * Returns the ids that are no longer on the companion: deleted now, or already absent.
     * Ids that could not be deleted (unreachable, invalid) are left out.
     */
    override suspend fun deleteRemoteSessions(sessionIds: List<String>): List<String> {
        val api = current()?.api ?: return emptyList()
        val removed = ArrayList<String>()
        for (id in sessionIds.distinct()) {
            if (!Ids.UUID4.matches(id)) continue
            try {
                api.deleteSession(id)
                removed += id
            } catch (e: CompanionException) {
                if (e.kind == CompanionException.Kind.UNREACHABLE || e.kind == CompanionException.Kind.UNAUTHORIZED ||
                    e.kind == CompanionException.Kind.FINGERPRINT_MISMATCH) break   // the rest would fail the same way
            }
        }
        return removed
    }

    private fun notifyChanged() {
        try { onChanged() } catch (_: Exception) { }
    }

    companion object {
        const val PRODUCT = "pocket3d-companion"
        const val API_VERSION = 1

        /** `https://host:port`; IPv6 literals get brackets. Cleartext is never an option. */
        fun baseUrl(host: String, port: Int): String =
            if (host.contains(':')) "https://[$host]:$port" else "https://$host:$port"

        private fun hostOf(url: String): String = url.removePrefix("https://")
    }
}
