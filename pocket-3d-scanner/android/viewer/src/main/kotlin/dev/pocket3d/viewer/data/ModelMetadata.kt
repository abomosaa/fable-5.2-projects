package dev.pocket3d.viewer.data

import dev.pocket3d.core.math.Quat
import dev.pocket3d.core.math.Vec3
import dev.pocket3d.core.mesh.OrientedBox
import dev.pocket3d.core.project.CamerasDocument
import dev.pocket3d.core.project.ModelCamera
import dev.pocket3d.core.project.ScaleInfo
import dev.pocket3d.core.project.UnregisteredFrame
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Base64

/** Lenient JSON used for everything the companion writes (unknown keys are expected). */
internal val LenientJson = Json { ignoreUnknownKeys = true; isLenient = true; coerceInputValues = true; explicitNulls = false }

internal fun JsonObject.objOrNull(name: String): JsonObject? = this[name] as? JsonObject
internal fun JsonObject.arrOrNull(name: String): JsonArray? = this[name] as? JsonArray
internal fun JsonObject.stringOrNull(name: String): String? =
    (this[name] as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString }?.content
internal fun JsonObject.doubleOrNull(name: String): Double? =
    (this[name] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.doubleOrNull?.takeIf { it.isFinite() }
internal fun JsonObject.intOrNull(name: String): Int? = (this[name] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.intOrNull
internal fun JsonObject.boolOrNull(name: String): Boolean? = (this[name] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.booleanOrNull
internal fun JsonElement?.floats(count: Int): FloatArray? {
    val a = this as? JsonArray ?: return null
    if (a.size != count) return null
    val out = FloatArray(count)
    for (i in 0 until count) {
        val v = (a[i] as? JsonPrimitive)?.doubleOrNull ?: return null
        if (!v.isFinite()) return null
        out[i] = v.toFloat()
    }
    return out
}
internal fun JsonObject.vec3OrNull(name: String): Vec3? = this[name].floats(3)?.let { Vec3(it[0], it[1], it[2]) }

/** The crop the reconstruction proposes. A suggestion only — the delivered mesh deliberately includes more. */
data class SuggestedCrop(
    val box: OrientedBox,
    /** How the companion arrived at it, shown verbatim to the user. */
    val basis: String,
    /** True when the companion could not anchor the suggestion well (e.g. no support plane found). */
    val uncertain: Boolean,
)

/** Plane `normal · p + d = 0` in model coordinates (the support surface found by the companion). */
data class GroundPlane(val normal: Vec3, val d: Float) {
    /** A point on the plane (the one closest to the origin). */
    val point: Vec3 get() = normal * (-d / normal.lengthSq().coerceAtLeast(1e-12f))
    fun signedDistance(p: Vec3): Float = (normal.dot(p) + d) / normal.length().coerceAtLeast(1e-12f)
}

/** `asset.extras.pocket3d` of a companion GLB, decoded leniently: every part is optional. */
data class ModelExtras(
    val scale: ScaleInfo? = null,
    val suggestedCrop: SuggestedCrop? = null,
    val ground: GroundPlane? = null,
    val preset: String? = null,
    val settingsFingerprint: String? = null,
    val originNote: String? = null,
    val holesPreserved: Boolean? = null,
    val confidenceDefinition: String? = null,
) {
    companion object {
        fun parse(assetExtras: JsonObject?): ModelExtras {
            val p = assetExtras?.objOrNull("pocket3d") ?: return ModelExtras()
            val scale = p.objOrNull("scale")?.let {
                runCatching { LenientJson.decodeFromJsonElement<ScaleInfo>(it) }.getOrNull()
            }
            val crop = p.objOrNull("suggested_crop")?.let { c ->
                val center = c.vec3OrNull("center")
                val half = c.vec3OrNull("half_extents")
                val rot = c["rotation"].floats(4)
                if (center == null || half == null || !(half.x > 0f && half.y > 0f && half.z > 0f)) null
                else SuggestedCrop(
                    OrientedBox(center, rot?.let { Quat(it[0], it[1], it[2], it[3]).normalized() } ?: Quat.IDENTITY, half),
                    c.stringOrNull("basis") ?: "",
                    c.boolOrNull("uncertain") ?: false,
                )
            }
            val ground = parseGround(p["ground"])
            return ModelExtras(
                scale = scale,
                suggestedCrop = crop,
                ground = ground,
                preset = p.stringOrNull("preset"),
                settingsFingerprint = p.stringOrNull("settings_fingerprint"),
                originNote = p.objOrNull("frame")?.stringOrNull("origin"),
                holesPreserved = p.boolOrNull("holes_preserved"),
                confidenceDefinition = p.objOrNull("confidence")?.stringOrNull("definition"),
            )
        }

        fun parseGround(e: JsonElement?): GroundPlane? {
            val g = e as? JsonObject ?: return null
            val n = g.vec3OrNull("normal") ?: return null
            val d = g.doubleOrNull("d") ?: return null
            if (n.length() < 1e-6f) return null
            return GroundPlane(n.normalized(), (d / n.length()).toFloat())
        }
    }
}

/** A warning or limitation reported by the reconstruction. */
data class DiagnosticNote(val code: String, val message: String)

data class TexturePageInfo(val width: Int, val height: Int, val bytes: Long, val format: String)

/** The parts of diagnostics.json the viewer shows. */
data class Diagnostics(
    val warnings: List<DiagnosticNote> = emptyList(),
    val limitations: List<String> = emptyList(),
    val texturePages: List<TexturePageInfo> = emptyList(),
    val inputFrames: Int? = null,
    val registeredFrames: Int? = null,
    val meanReprojectionErrorPx: Double? = null,
) {
    companion object {
        fun parse(text: String): Diagnostics {
            val root = LenientJson.parseToJsonElement(text) as? JsonObject ?: return Diagnostics()
            val warnings = root.arrOrNull("warnings")?.mapNotNull { w ->
                when (w) {
                    is JsonObject -> DiagnosticNote(w.stringOrNull("code") ?: "", w.stringOrNull("message") ?: return@mapNotNull null)
                    is JsonPrimitive -> if (w.isString) DiagnosticNote("", w.content) else null
                    else -> null
                }
            } ?: emptyList()
            val limitations = root.arrOrNull("limitations")?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content } ?: emptyList()
            val pages = root.objOrNull("texture")?.arrOrNull("pages")?.mapNotNull { p ->
                val o = p as? JsonObject ?: return@mapNotNull null
                TexturePageInfo(o.intOrNull("width") ?: 0, o.intOrNull("height") ?: 0,
                                (o.doubleOrNull("bytes") ?: 0.0).toLong(), o.stringOrNull("format") ?: "")
            } ?: emptyList()
            val sfm = root.objOrNull("sfm")
            return Diagnostics(warnings, limitations, pages,
                               inputFrames = sfm?.intOrNull("input_frames") ?: root.objOrNull("input")?.intOrNull("frames"),
                               registeredFrames = sfm?.intOrNull("registered"),
                               meanReprojectionErrorPx = sfm?.doubleOrNull("mean_reprojection_error_px"))
        }
    }
}

object CamerasJson {
    fun parse(text: String): CamerasDocument = LenientJson.decodeFromString(CamerasDocument.serializer(), text)

    /** Why a photo is not part of the reconstruction, in words. */
    fun describeReason(reason: String): String = when (reason) {
        "no_reliable_matches" -> "No reliable matches with the other photos"
        "separate_group" -> "Matched only a separate group of photos, not the main model"
        "" -> "Not registered (no reason reported)"
        else -> reason.replace('_', ' ').replaceFirstChar { it.uppercase() }
    }
}

/**
 * The provisional structure-from-motion preview the companion sends while the dense stages are
 * still running: sparse tie points and camera positions only.
 */
class SparsePreview(
    val provisional: Boolean,
    val units: String,
    val note: String,
    /** xyz per point. */
    val points: FloatArray,
    /** rgb per point (may be empty when the companion sent no colours). */
    val colors: ByteArray,
    val totalPointsInModel: Int,
    val cameras: List<ModelCamera>,
    val unregistered: List<UnregisteredFrame>,
    val objectCenter: Vec3,
    val objectRadius: Float,
    val ground: GroundPlane?,
) {
    val pointCount: Int get() = points.size / 3

    companion object {
        /** @throws IllegalArgumentException with a readable message when the file is not a usable preview. */
        fun parse(text: String): SparsePreview {
            val root = try {
                LenientJson.parseToJsonElement(text) as? JsonObject
            } catch (e: Exception) {
                throw IllegalArgumentException("The preview file is not valid JSON.", e)
            } ?: throw IllegalArgumentException("The preview file has an unexpected structure.")
            val pts = root.objOrNull("points")
            val xyz = pts?.stringOrNull("xyz_f32_b64")?.let { decodeBase64(it, "point positions") } ?: ByteArray(0)
            if (xyz.size % 12 != 0) throw IllegalArgumentException("Point data is truncated (${xyz.size} bytes is not a multiple of 12).")
            val declared = pts?.intOrNull("count")
            val n = xyz.size / 12
            if (declared != null && declared != n) throw IllegalArgumentException("Point data does not match its declared count ($n of $declared points).")
            val positions = FloatArray(n * 3)
            ByteBuffer.wrap(xyz).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer().get(positions)
            for (v in positions) if (!v.isFinite()) throw IllegalArgumentException("Point data contains invalid numbers.")
            var rgb = pts?.stringOrNull("rgb_u8_b64")?.let { decodeBase64(it, "point colours") } ?: ByteArray(0)
            if (rgb.size != n * 3) rgb = ByteArray(0)
            val cameras = root.arrOrNull("cameras")?.mapNotNull {
                runCatching { LenientJson.decodeFromJsonElement<ModelCamera>(it) }.getOrNull()
                    ?.takeIf { c -> c.position.size == 3 && c.q.size == 4 }
            } ?: emptyList()
            val unregistered = root.arrOrNull("unregistered")?.mapNotNull { u ->
                when (u) {
                    is JsonObject -> runCatching { LenientJson.decodeFromJsonElement<UnregisteredFrame>(u) }.getOrNull()
                    is JsonPrimitive -> if (u.isString) UnregisteredFrame(u.content) else null
                    else -> null
                }
            } ?: emptyList()
            val obj = root.objOrNull("object")
            return SparsePreview(
                provisional = root.boolOrNull("provisional") ?: true,
                units = root.stringOrNull("units") ?: "arbitrary",
                note = root.stringOrNull("note") ?: "",
                points = positions,
                colors = rgb,
                totalPointsInModel = pts?.intOrNull("total_in_model") ?: n,
                cameras = cameras,
                unregistered = unregistered,
                objectCenter = obj?.vec3OrNull("center") ?: Vec3.ZERO,
                objectRadius = (obj?.doubleOrNull("radius_estimate") ?: 0.0).toFloat(),
                ground = ModelExtras.parseGround(root["ground"]),
            )
        }

        private fun decodeBase64(s: String, what: String): ByteArray = try {
            Base64.getDecoder().decode(s)
        } catch (e: IllegalArgumentException) {
            throw IllegalArgumentException("The $what in the preview file are corrupt.", e)
        }
    }
}
