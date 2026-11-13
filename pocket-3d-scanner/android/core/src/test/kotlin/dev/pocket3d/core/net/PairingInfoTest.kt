package dev.pocket3d.core.net

import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class PairingInfoTest {
    private val fp = "dc5aa60a338f4edfe6cf8737300b22d22007f28f13e9ac5c6af0b41863e566ce"

    @Test fun parsesCompanionUri() {
        val p = PairingInfo.parse("pocket3d://pair?v=1&host=192.168.1.21,10.0.2.2&port=18443&fp=$fp&code=2H4X9SN4")!!
        assertEquals(listOf("192.168.1.21", "10.0.2.2"), p.hosts)
        assertEquals(18443, p.port)
        assertEquals(fp, p.fingerprintSha256)
        assertEquals("2H4X9SN4", p.code)
    }

    @Test fun toleratesWhitespaceCaseAndFingerprintGrouping() {
        val grouped = fp.uppercase().chunked(4).joinToString("%20")
        assertNotNull(PairingInfo.parse("  POCKET3D://pair?v=1&host=10.0.2.2&port=8443&fp=$grouped&code=2h4x9sn4 \n"))
        assertEquals(fp, PairingInfo.normalizeFingerprint(fp.chunked(4).joinToString(" ")))
        assertEquals(fp, PairingInfo.normalizeFingerprint(fp.chunked(2).joinToString(":").uppercase()))
    }

    @Test fun rejectsMalformedOrHostileInput() {
        val ok = "pocket3d://pair?v=1&host=10.0.2.2&port=8443&fp=$fp&code=2H4X9SN4"
        assertNotNull(PairingInfo.parse(ok))
        assertNull(PairingInfo.parse("https://example.com/pair?v=1&host=10.0.2.2&port=8443&fp=$fp&code=2H4X9SN4"))
        assertNull(PairingInfo.parse(ok.replace("v=1", "v=2")))
        assertNull(PairingInfo.parse(ok.replace("port=8443", "port=99999")))
        assertNull(PairingInfo.parse(ok.replace("port=8443", "port=0")))
        assertNull(PairingInfo.parse(ok.replace(fp, fp.dropLast(2))))                 // truncated fingerprint
        assertNull(PairingInfo.parse(ok.replace(fp, fp.dropLast(1) + "z")))
        assertNull(PairingInfo.parse(ok.replace("2H4X9SN4", "2H4X9SN")))              // short code
        assertNull(PairingInfo.parse(ok.replace("2H4X9SN4", "2H4X9SN1")))             // '1' is not in the alphabet
        assertNull(PairingInfo.parse(ok.replace("host=10.0.2.2", "host=evil.example/path")))
        assertNull(PairingInfo.parse(ok.replace("host=10.0.2.2", "host=a%40b")))      // user-info smuggling
        assertNull(PairingInfo.parse(ok.replace("host=10.0.2.2", "host=")))
        assertNull(PairingInfo.parse(""))
        assertNull(PairingInfo.parse("pocket3d://pair?"))
    }

    @Test fun protocolJsonIgnoresUnknownFieldsFromNewerCompanions() {
        val job = ProtocolJson.decodeFromString(JobPollResponse.serializer(),
            """{"job":{"job_id":"j","session_id":"s","state":"running","stage":"dense","stage_progress":0.4,
               "overall_progress":0.5,"diagnostics":{"peak_rss_mb":1234.5,"sfm":{"registered":8}},
               "artifacts":[{"name":"sparse_preview.json","size":3,"sha256":"ab","kind":"preview"}],"brand_new_field":1},
               "events":[{"seq":7,"t":1.0,"type":"stage_progress","stage":"dense","progress":0.4,"overall":0.5,
               "message":"Depth maps","data":{}}, {"seq":8,"t":1.0,"type":"x","stage":null,"progress":null,"overall":null,"message":"","data":{}}],
               "last_seq":8,"future":true}""")
        assertEquals("running", job.job.state)
        assertEquals(8, job.lastSeq)
        assertEquals(0.5, job.job.overallProgress, 0.0)
        assertEquals(1, job.job.artifacts.size)
        assertEquals("8", job.job.diagnostics["sfm"]!!.jsonObject["registered"].toString())
    }
}
