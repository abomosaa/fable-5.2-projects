package com.detailedcapture.app

import android.graphics.PointF
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else (0 until length()).map { optString(it) }
fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }

class Frame(val j: JSONObject) {
    val id: String get() = j.optString("id")
    val role: String get() = j.optString("role")
    val file: String get() = j.optString("file")
    val working: String? get() = if (j.has("working") && !j.isNull("working")) j.optString("working") else null
    val thumb: String get() = j.optString("thumb")
    val meta: JSONObject get() = j.optJSONObject("meta") ?: JSONObject()
    val width: Int get() = meta.optInt("width")
    val height: Int get() = meta.optInt("height")
    val orientation: Int get() = meta.optInt("orientation", 1)
    val format: String get() = meta.optString("format")
    val reg: JSONObject get() = j.optJSONObject("reg") ?: JSONObject()
    val user: JSONObject get() = j.optJSONObject("user") ?: JSONObject()
    val quality: JSONObject get() = j.optJSONObject("quality") ?: JSONObject()
    val status: String get() = reg.optString("status", "unprocessed")
    val reasons: List<String> get() = reg.optJSONArray("reasons").strings()
    val warnings: List<String> get() = reg.optJSONArray("warnings").strings() + j.optJSONArray("warnings").strings().filter { it !in reg.optJSONArray("warnings").strings() }
    val messages: List<String> get() = reg.optJSONArray("messages").strings()
    val included: Boolean get() = user.optBoolean("included", true)
    val removed: Boolean get() = user.optBoolean("removed", false)
    val scale: Double get() = reg.optDouble("scale", 0.0)
    val effGain: Double get() = reg.optDouble("effGain", 0.0)
    val originalName: String get() = j.optString("originalName")
    val hasPosition: Boolean get() = reg.has("footprint")
    val footprint: List<PointF>
        get() {
            val a = reg.optJSONArray("footprint") ?: return emptyList()
            return (0 until a.length()).map { val p = a.getJSONArray(it); PointF(p.getDouble(0).toFloat(), p.getDouble(1).toFloat()) }
        }
    val manualPoints: JSONArray get() = user.optJSONArray("manualPoints") ?: JSONArray()

    /** Status as shown to the user (exclusion by the user wins over the automatic verdict). */
    val displayStatus: String get() = if (!included) "excluded" else status
}

class ResultInfo(val j: JSONObject) {
    val runId: String get() = j.optString("runId")
    val width: Int get() = j.optInt("width")
    val height: Int get() = j.optInt("height")
    val scale: Double get() = j.optDouble("scale", 1.0)
    val stale: Boolean get() = j.optBoolean("stale", false)
    val stats: JSONObject get() = j.optJSONObject("stats") ?: JSONObject()
    val maxLevel: Int get() = j.optInt("maxLevel")
}

class Project(val dir: File, val j: JSONObject) {
    val name: String get() = j.optString("name", "Untitled")
    val frames: List<Frame> by lazy { j.optJSONArray("frames").objects().map { Frame(it) } }
    val overview: Frame? get() = frames.firstOrNull { it.role == "overview" }
    val closeups: List<Frame> get() = frames.filter { it.role == "closeup" && !it.removed }
    val removedCount: Int get() = frames.count { it.role == "closeup" && it.removed }
    val result: ResultInfo? get() = j.optJSONObject("result")?.let { ResultInfo(it) }
    val edits: JSONObject get() = j.optJSONObject("edits") ?: JSONObject()
    val settings: JSONObject get() = j.optJSONObject("settings") ?: JSONObject()
    val calibration: JSONObject? get() = j.optJSONObject("calibration")
    val job: JSONObject? get() = j.optJSONObject("job")
    val canUndo: Boolean get() = (j.optJSONArray("undo")?.length() ?: 0) > 0
    val canRedo: Boolean get() = (j.optJSONArray("redo")?.length() ?: 0) > 0
    val registration: JSONObject? get() = j.optJSONObject("registration")
    fun frame(id: String): Frame? = frames.firstOrNull { it.id == id }

    /** Human-readable name of a photo: its position in the project plus the original file name when known. */
    fun labelOf(id: String): String {
        val f = frame(id) ?: return id
        if (f.role == "overview") return "Overview"
        val n = frames.filter { it.role == "closeup" }.indexOfFirst { it.id == id } + 1
        return "Close-up $n" + if (f.originalName.isNotEmpty()) " (${f.originalName})" else ""
    }
    fun file(rel: String): File = File(dir, rel)
    fun count(status: String) = closeups.count { it.displayStatus == status }
    val resultDir: File? get() = result?.let { File(dir, "results/${it.runId}") }
}

/** Plain-language labels for statuses. */
fun statusLabel(s: String) = when (s) {
    "accepted" -> "Verified"
    "rejected" -> "Rejected"
    "uncertain" -> "Uncertain"
    "excluded" -> "Excluded"
    "anchor" -> "Overview"
    else -> "Not processed yet"
}
