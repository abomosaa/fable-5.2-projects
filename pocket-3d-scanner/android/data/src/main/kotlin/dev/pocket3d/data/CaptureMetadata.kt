package dev.pocket3d.data

import dev.pocket3d.core.project.CaptureSession
import dev.pocket3d.core.project.CaptureSource
import dev.pocket3d.core.project.Frame
import dev.pocket3d.core.project.ScaleInfo
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import java.io.File

/**
 * Builds the `capture` object of a session manifest exactly as specified in
 * docs/companion-protocol.md §5. Written by hand (not from the storage serialisers) so that the
 * wire format cannot drift when the on-phone model gains fields. The output is deterministic:
 * the companion treats any change of `capture` as a changed session.
 */
internal object CaptureMetadata {

    private fun num(v: Double?): JsonElement = if (v == null || !v.isFinite()) JsonNull else JsonPrimitive(v)
    private fun nums(v: List<Double>): JsonArray = buildJsonArray { v.forEach { add(num(it)) } }
    private fun finite(v: List<Double>) = v.all { it.isFinite() }

    /** @param frames the frames of the job, in job order (a subset of [session]'s frames) */
    fun build(session: CaptureSession, frames: List<Frame>): JsonObject = buildJsonObject {
        val ids = frames.mapTo(HashSet()) { it.id }
        put("format", JsonPrimitive(1))
        put("source", JsonPrimitive(when (session.source) {
            CaptureSource.CAMERA_AR -> "camera_ar"
            CaptureSource.CAMERA -> "camera"
            CaptureSource.IMPORT -> "import"
        }))
        put("device", buildJsonObject {
            put("manufacturer", JsonPrimitive(session.device.manufacturer.take(64)))
            put("model", JsonPrimitive(session.device.model.take(64)))
            put("android_sdk", JsonPrimitive(session.device.androidSdk))
        })
        put("frames", buildJsonArray { frames.forEach { add(frame(it)) } })
        put("tracking", buildJsonObject {
            put("mode", JsonPrimitive(session.tracking.mode))
            put("segments", buildJsonArray {
                for (seg in session.tracking.segments) {
                    val members = seg.frames.filter { it in ids }
                    if (members.isEmpty()) continue
                    add(buildJsonObject {
                        put("segment", JsonPrimitive(seg.segment))
                        put("frames", buildJsonArray { members.forEach { add(JsonPrimitive(it)) } })
                    })
                }
            })
        })
        val c = session.objectCenterAr
        put("object_center_ar", if (c != null && c.size == 3 && finite(c)) nums(c) else JsonNull)
    }

    private fun frame(f: Frame): JsonObject = buildJsonObject {
        put("id", JsonPrimitive(f.id))
        put("name", JsonPrimitive(f.name.take(255)))
        put("timestamp_ms", f.timestampMs?.let { JsonPrimitive(it) } ?: JsonNull)
        put("width", JsonPrimitive(f.width))
        put("height", JsonPrimitive(f.height))
        put("exif_orientation", JsonPrimitive(if (f.exifOrientation in 1..8) f.exifOrientation else 1))
        val k = f.intrinsics
        put("intrinsics", if (k != null && finite(listOf(k.fx, k.fy, k.cx, k.cy)) && k.fx > 0 && k.fy > 0) buildJsonObject {
            put("fx", JsonPrimitive(k.fx)); put("fy", JsonPrimitive(k.fy))
            put("cx", JsonPrimitive(k.cx)); put("cy", JsonPrimitive(k.cy))
            put("source", JsonPrimitive(k.source))
        } else JsonNull)
        val d = f.distortion
        put("distortion", if (d != null && d.k.isNotEmpty() && finite(d.k)) buildJsonObject {
            put("model", JsonPrimitive(d.model))
            put("k", nums(d.k))
        } else JsonNull)
        val p = f.pose
        put("pose", if (p != null && p.t.size == 3 && p.q.size == 4 && finite(p.t) && finite(p.q)) buildJsonObject {
            put("t", nums(p.t))
            put("q", nums(p.q))
            put("segment", JsonPrimitive(p.segment))
        } else JsonNull)
        put("focus", f.focus?.let {
            buildJsonObject {
                put("locked", JsonPrimitive(it.locked))
                put("distance_diopters", num(it.distanceDiopters))
            }
        } ?: JsonNull)
        put("exposure", f.exposure?.let {
            buildJsonObject {
                put("locked", JsonPrimitive(it.locked))
                put("iso", it.iso?.let { v -> JsonPrimitive(v) } ?: JsonNull)
                put("exposure_ns", it.exposureNs?.let { v -> JsonPrimitive(v) } ?: JsonNull)
            }
        } ?: JsonNull)
        put("quality", buildJsonObject {
            put("sharpness", num(f.quality.sharpness))
            put("clipped_low", num(f.quality.clippedLow))
            put("clipped_high", num(f.quality.clippedHigh))
            put("overlap", num(f.quality.overlap))
        })
        put("flags", buildJsonArray { f.flags.take(16).forEach { add(JsonPrimitive(it)) } })
    }
}

/** Reads the numbers a [dev.pocket3d.core.project.ModelVersion] records from `diagnostics.json`. */
internal object DiagnosticsReader {
    private const val MAX_BYTES = 16L * 1024 * 1024
    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true; explicitNulls = false }

    fun read(file: File?): ModelStats {
        if (file == null || !file.isFile || file.length() > MAX_BYTES) return ModelStats()
        val root = try {
            json.parseToJsonElement(file.readText(Charsets.UTF_8)) as? JsonObject
        } catch (_: Exception) {
            null
        } ?: return ModelStats()
        return fromJson(root)
    }

    fun fromJson(root: JsonObject): ModelStats {
        val mesh = root["mesh"] as? JsonObject
        val sfm = root["sfm"] as? JsonObject
        val pages = ((root["texture"] as? JsonObject)?.get("pages") as? JsonArray) ?: JsonArray(emptyList())
        val scale = (root["scale"] as? JsonObject)?.let {
            try { json.decodeFromJsonElement(ScaleInfo.serializer(), it) } catch (_: Exception) { null }
        } ?: ScaleInfo()
        return ModelStats(
            vertexCount = int(mesh?.get("vertices")),
            faceCount = int(mesh?.get("faces")),
            textureBytes = pages.sumOf { p -> ((p as? JsonObject)?.get("bytes") as? JsonPrimitive)?.longOrNull ?: 0L },
            registeredCameras = int(sfm?.get("registered")),
            inputFrames = int(sfm?.get("input_frames")),
            // A scale that claims metres without a factor is not a metric scale.
            scale = if (scale.units == "meters" && (scale.metersPerUnit == null || !(scale.metersPerUnit!! > 0.0)))
                ScaleInfo(note = scale.note) else scale,
            settingsFingerprint = (((root["job"] as? JsonObject)?.get("settings_fingerprint")) as? JsonPrimitive)
                ?.takeIf { it.isString }?.content ?: "",
        )
    }

    private fun int(e: JsonElement?): Int {
        val p = e as? JsonPrimitive ?: return 0
        return p.intOrNull ?: p.doubleOrNull?.takeIf { it.isFinite() && it >= 0 && it < Int.MAX_VALUE }?.toInt() ?: 0
    }
}
