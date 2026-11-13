package dev.pocket3d.data

import dev.pocket3d.core.net.ArtifactInfo
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.security.MessageDigest

/**
 * The real HTTP client against a real TLS server (MockWebServer with a self-signed certificate):
 * pinning, authentication, resumable upload and verified, resumable download.
 */
class CompanionClientTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var server: MockWebServer
    private lateinit var cert: HeldCertificate
    private val token = "a".repeat(64)
    private val quick = CompanionClient.Timeouts(connectMs = 2000, readMs = 3000, writeMs = 3000)

    private fun fingerprint(c: HeldCertificate) =
        MessageDigest.getInstance("SHA-256").digest(c.certificate.encoded).joinToString("") { "%02x".format(it) }

    @Before fun setUp() {
        cert = HeldCertificate.Builder().commonName("pocket3d-companion").addSubjectAlternativeName("localhost").build()
        server = MockWebServer()
        server.useHttps(HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory(), false)
        server.start()
    }

    @After fun tearDown() { server.shutdown() }

    private fun client(fp: String = fingerprint(cert), tok: String? = token, chunk: Int = 1000) =
        CompanionClient("https://127.0.0.1:${server.port}", fp, tok, timeouts = quick, chunkBytes = chunk)

    private fun json(code: Int, body: String) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    @Test fun pinnedCertificateIsAcceptedAndBearerTokenIsSent() = runBlocking {
        server.enqueue(json(200, """{"version":"1.0.0","api":1,"server_id":"s","server_name":"PC","limits":{"max_images":123}}"""))
        val status = client().status()
        assertEquals(123, status.limits.maxImages)
        val req = server.takeRequest()
        assertEquals("/v1/status", req.path)
        assertEquals("Bearer $token", req.getHeader("Authorization"))
    }

    @Test fun aDifferentCertificateIsRefusedEvenThoughTheServerAnswers() = runBlocking {
        server.enqueue(json(200, "{}"))
        val other = HeldCertificate.Builder().commonName("pocket3d-companion").build()
        try { client(fp = fingerprint(other)).status(); fail("accepted a certificate that is not the pinned one") }
        catch (e: CompanionException) { assertEquals(CompanionException.Kind.FINGERPRINT_MISMATCH, e.kind) }
        assertEquals(0, server.requestCount)                 // no request (and no token) ever left the phone
    }

    @Test fun cleartextAndMalformedAddressesAreRejectedUpFront() {
        for (bad in listOf("http://127.0.0.1:${server.port}", "ftp://x", "not a url"))
            try { CompanionClient(bad, fingerprint(cert), token); fail(bad) } catch (_: IllegalArgumentException) { }
    }

    @Test fun errorEnvelopeBecomesTypedExceptionAndNeverContainsTheToken() = runBlocking {
        server.enqueue(json(401, """{"error":{"code":"unauthorized","message":"unknown token"}}"""))
        server.enqueue(json(409, """{"error":{"code":"incomplete_upload","message":"2 files missing"}}"""))
        server.enqueue(MockResponse().setResponseCode(200).setBody("<html>captive portal</html>"))
        val c = client()
        try { c.status(); fail() } catch (e: CompanionException) {
            assertEquals(CompanionException.Kind.UNAUTHORIZED, e.kind); assertFalse(e.message.contains(token))
        }
        try { c.getSession("11111111-1111-4111-8111-111111111111"); fail() } catch (e: CompanionException) {
            assertEquals(CompanionException.Kind.API, e.kind); assertEquals("incomplete_upload", e.code); assertEquals(409, e.httpStatus)
        }
        try { c.status(); fail() } catch (e: CompanionException) { assertEquals(CompanionException.Kind.PROTOCOL, e.kind) }
    }

    @Test fun unreachableIsDistinguishedFromEverythingElse() = runBlocking {
        val port = server.port
        server.shutdown()
        try { CompanionClient("https://127.0.0.1:$port", fingerprint(cert), token, timeouts = quick).status(); fail() }
        catch (e: CompanionException) { assertEquals(CompanionException.Kind.UNREACHABLE, e.kind); assertTrue(e.isTransient) }
    }

    /** A little in-memory upload endpoint with the real offset/sha semantics. */
    private class UploadServer(val size: Long, val sha: String) : Dispatcher() {
        val stored = Buffer()
        var dropNext = 0            // drop the connection for this many upcoming PUTs (after reading half the body)
        var lieOnce = false         // answer one PUT with 409 offset_mismatch
        val putOffsets = ArrayList<Long>()
        var gets = 0
        override fun dispatch(request: RecordedRequest): MockResponse {
            if (request.method == "GET") { gets++; return sessionJson() }
            val offset = request.getHeader("Upload-Offset")!!.toLong()
            synchronized(this) {
                putOffsets += offset
                if (dropNext > 0) {
                    dropNext--
                    val half = request.body.size / 2
                    if (offset == stored.size) stored.write(request.body, half)     // the server kept what arrived
                    return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                }
                if (lieOnce || offset != stored.size) {
                    lieOnce = false
                    return MockResponse().setResponseCode(409).setHeader("Content-Type", "application/json")
                        .setBody("""{"error":{"code":"offset_mismatch","message":"offset"},"received":${stored.size}}""")
                }
                stored.write(request.body, request.body.size)
                val complete = stored.size == size
                if (complete) {
                    val actual = stored.clone().sha256().hex()
                    if (actual != sha) { stored.clear(); return MockResponse().setResponseCode(422).setHeader("Content-Type", "application/json")
                        .setBody("""{"error":{"code":"checksum_mismatch","message":"sha"},"received":0}""") }
                }
                return MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json")
                    .setBody("""{"id":"f1","received":${stored.size},"complete":$complete}""")
            }
        }
        private fun sessionJson() = MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody(
            """{"session_id":"s","total_bytes":$size,"received_bytes":${stored.size},"complete":${stored.size == size},
               "files":[{"id":"f1","size":$size,"received":${stored.size},"complete":${stored.size == size}}]}""")
    }

    private val sid = "11111111-1111-4111-8111-111111111111"

    @Test fun uploadIsChunkedAndResumesAfterADroppedConnectionWithoutResendingStoredBytes() = runBlocking {
        val data = randomBytes(10_500, 3)
        val file = tmp.newFile().apply { writeBytes(data) }
        val up = UploadServer(data.size.toLong(), StorageFiles.sha256(data)).apply { dropNext = 1 }
        server.dispatcher = up
        val progress = ArrayList<Long>()
        client(chunk = 2000).uploadFile(sid, "f1", file, data.size.toLong(), StorageFiles.sha256(data), 0) { synchronized(progress) { progress += it } }
        assertTrue(up.stored.clone().readByteArray().contentEquals(data))
        assertTrue("re-synchronised with the server after the drop", up.gets >= 1)
        assertTrue(up.putOffsets.contains(1000L))                    // resumed from what the server had kept (half a chunk)
        assertTrue(up.putOffsets.all { it <= data.size })
        assertEquals(data.size.toLong(), progress.max())
    }

    @Test fun uploadStartsAtTheGivenOffsetAndFollowsTheServerOnMismatch() = runBlocking {
        val data = randomBytes(6000, 4)
        val file = tmp.newFile().apply { writeBytes(data) }
        val up = UploadServer(data.size.toLong(), StorageFiles.sha256(data))
        up.stored.write(data, 0, 2500)                               // server already has 2500 bytes…
        server.dispatcher = up
        client(chunk = 4000).uploadFile(sid, "f1", file, data.size.toLong(), StorageFiles.sha256(data), 1000)   // …phone believes 1000
        assertTrue(up.stored.clone().readByteArray().contentEquals(data))
        assertEquals(1000L, up.putOffsets.first())
        assertTrue(up.putOffsets.contains(2500L))
    }

    @Test fun persistentChecksumMismatchEndsAsIntegrityErrorNotAsSuccess() = runBlocking {
        val data = randomBytes(3000, 5)
        val file = tmp.newFile().apply { writeBytes(data) }
        server.dispatcher = UploadServer(data.size.toLong(), "0".repeat(64))      // server expects another hash
        try { client().uploadFile(sid, "f1", file, data.size.toLong(), "0".repeat(64), 0); fail("reported success") }
        catch (e: CompanionException) { assertTrue(e.kind == CompanionException.Kind.INTEGRITY || e.code == "checksum_mismatch") }
    }

    @Test fun downloadVerifiesChecksumAndResumesWithRange() = runBlocking {
        val data = randomBytes(9000, 6)
        val art = ArtifactInfo("model.glb", data.size.toLong(), StorageFiles.sha256(data), "model")
        val dest = File(tmp.root, "model.glb")
        File(tmp.root, "model.glb.part").writeBytes(data.copyOf(4000))           // a previous attempt got 4000 bytes
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val range = request.getHeader("Range") ?: return MockResponse().setBody(Buffer().write(data))
                val from = range.removePrefix("bytes=").substringBefore('-').toInt()
                return MockResponse().setResponseCode(206).setHeader("Content-Range", "bytes $from-${data.size - 1}/${data.size}")
                    .setBody(Buffer().write(data, from, data.size - from))
            }
        }
        client().downloadArtifact("22222222-2222-4222-8222-222222222222", art, dest)
        assertTrue(dest.readBytes().contentEquals(data))
        assertFalse(File(tmp.root, "model.glb.part").exists())
        assertEquals("bytes=4000-", server.takeRequest().getHeader("Range"))
    }

    @Test fun damagedDownloadIsRejectedAndLeavesNoFile() = runBlocking {
        val data = randomBytes(5000, 7)
        val art = ArtifactInfo("model.glb", data.size.toLong(), StorageFiles.sha256(data), "model")
        val dest = File(tmp.root, "bad.glb")
        val damaged = data.copyOf().also { it[100] = (it[100] + 1).toByte() }
        server.enqueue(MockResponse().setBody(Buffer().write(damaged)))
        try { client().downloadArtifact("22222222-2222-4222-8222-222222222222", art, dest); fail("accepted damaged data") }
        catch (e: CompanionException) { assertEquals(CompanionException.Kind.INTEGRITY, e.kind) }
        assertFalse(dest.exists())
        assertFalse(File(tmp.root, "bad.glb.part").exists())
        assertNull(tmp.root.listFiles()!!.firstOrNull { it.name.startsWith("bad") })
    }
}
