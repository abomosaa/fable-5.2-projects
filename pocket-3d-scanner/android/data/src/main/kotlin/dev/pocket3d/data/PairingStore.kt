package dev.pocket3d.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.util.Base64
import java.util.UUID

/** Everything the phone remembers about its companion. The token is a secret. */
data class PairingRecord(
    val serverId: String,
    val serverName: String,
    /** `https://host:port` candidates, the one that worked last first. */
    val baseUrls: List<String>,
    val fingerprintSha256: String,
    val token: String,
    val deviceId: String,
) {
    override fun toString(): String =
        "PairingRecord(serverId=$serverId, serverName=$serverName, baseUrls=$baseUrls, token=<redacted>)"
}

/** Persists the pairing in app-private storage. Implementations must be thread-safe. */
interface PairingStore {
    /** The stored pairing, or null if the phone is not paired (or the secret can no longer be read). */
    fun load(): PairingRecord?
    fun save(record: PairingRecord)
    fun clear()
    /**
     * This installation's stable device id (lower-case UUID). It survives [clear], so pairing
     * again with the same companion keeps the phone's sessions and jobs there.
     */
    fun deviceId(): String
}

/** Encrypts the bearer token at rest. */
interface TokenCipher {
    fun encrypt(plain: ByteArray): ByteArray
    /** @throws Exception if the blob cannot be decrypted (wrong/lost key, tampering) */
    fun decrypt(blob: ByteArray): ByteArray
}

/** For tests and previews only: nothing is written anywhere. */
class InMemoryPairingStore(private val fixedDeviceId: String = UUID.randomUUID().toString()) : PairingStore {
    @Volatile private var record: PairingRecord? = null
    override fun load(): PairingRecord? = record
    override fun save(record: PairingRecord) { this.record = record }
    override fun clear() { record = null }
    override fun deviceId(): String = fixedDeviceId
}

/**
 * One small JSON file. Everything except the token is stored in the clear (none of it is
 * secret: server name, addresses, public certificate fingerprint); the token is stored only
 * as ciphertext produced by [cipher].
 */
class FilePairingStore(private val file: File, private val cipher: TokenCipher) : PairingStore {

    @Serializable
    private data class Stored(
        @SerialName("device_id") val deviceId: String = "",
        val pairing: StoredPairing? = null,
    )

    @Serializable
    private data class StoredPairing(
        @SerialName("server_id") val serverId: String,
        @SerialName("server_name") val serverName: String = "",
        @SerialName("base_urls") val baseUrls: List<String>,
        @SerialName("fingerprint_sha256") val fingerprintSha256: String,
        @SerialName("token_enc") val tokenEnc: String,
    )

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }
    private val lock = Any()

    private fun read(): Stored {
        if (!file.isFile) return Stored()
        return try {
            json.decodeFromString(Stored.serializer(), file.readText(Charsets.UTF_8))
        } catch (_: Exception) {
            Stored()
        }
    }

    private fun write(s: Stored) =
        StorageFiles.writeAtomic(file, json.encodeToString(Stored.serializer(), s).toByteArray(Charsets.UTF_8),
            keepBackup = false)   // no stale copies of pairing data

    override fun load(): PairingRecord? = synchronized(lock) {
        val s = read()
        val p = s.pairing ?: return null
        val token = try {
            String(cipher.decrypt(Base64.getDecoder().decode(p.tokenEnc)), Charsets.UTF_8)
        } catch (_: Exception) {
            return null   // key lost (e.g. restored backup): the phone has to pair again
        }
        if (token.isEmpty() || s.deviceId.isEmpty()) return null
        PairingRecord(p.serverId, p.serverName, p.baseUrls, p.fingerprintSha256, token, s.deviceId)
    }

    override fun save(record: PairingRecord) = synchronized(lock) {
        val enc = Base64.getEncoder().encodeToString(cipher.encrypt(record.token.toByteArray(Charsets.UTF_8)))
        write(Stored(record.deviceId, StoredPairing(record.serverId, record.serverName, record.baseUrls,
            record.fingerprintSha256, enc)))
    }

    override fun clear() = synchronized(lock) {
        val s = read()
        if (s.pairing != null) write(s.copy(pairing = null))
    }

    override fun deviceId(): String = synchronized(lock) {
        val s = read()
        if (DEVICE_ID.matches(s.deviceId)) return s.deviceId
        val id = UUID.randomUUID().toString()
        write(s.copy(deviceId = id))
        id
    }

    private companion object {
        val DEVICE_ID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    }
}
