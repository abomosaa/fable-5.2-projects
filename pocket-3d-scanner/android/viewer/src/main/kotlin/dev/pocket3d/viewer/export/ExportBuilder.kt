package dev.pocket3d.viewer.export

import dev.pocket3d.core.edit.EditDocument
import dev.pocket3d.core.edit.EditOp
import dev.pocket3d.core.math.Mat4
import dev.pocket3d.core.mesh.Aabb
import dev.pocket3d.core.mesh.GlbDocument
import dev.pocket3d.core.mesh.GlbFormatException
import dev.pocket3d.core.mesh.GlbReader
import dev.pocket3d.core.mesh.GlbWriter
import dev.pocket3d.core.mesh.Mesh
import dev.pocket3d.core.mesh.MeshOps
import dev.pocket3d.core.mesh.ObjWriter
import dev.pocket3d.core.mesh.PlyWriter
import dev.pocket3d.core.scale.ScaleCalibration
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream
import kotlin.math.abs
import kotlin.math.max

enum class ExportFormat(val label: String, val extension: String, val mimeType: String, val description: String) {
    GLB("GLB", "glb", "model/gltf-binary", "Textured model in one file. Keeps evidence values and the repaired-surface marking."),
    OBJ_ZIP("OBJ (zip)", "zip", "application/zip", "OBJ + MTL + texture images in a zip. No evidence values (OBJ cannot store them)."),
    PLY("PLY", "ply", "application/octet-stream", "Geometry with evidence values and repaired flags. No texture image."),
}

/** A finished export, ready to be written somewhere. */
class ExportArtifact(
    val format: ExportFormat,
    val fileName: String,
    val bytes: ByteArray,
    /** What a correct read-back must contain. */
    val expected: Expected,
    /** True when positions were multiplied by the scale so that one unit is one metre. */
    val metric: Boolean,
    /** Plain-language statement of the units, shown in the result. */
    val unitsStatement: String,
) {
    class Expected(val vertexCount: Int, val faceCount: Int, val bounds: Aabb, val sha256: String, val zipEntries: List<String>)
}

/** Builds export files from the CURRENT (edited) mesh. Pure and JVM-testable. */
object ExportBuilder {
    private val PrettyJson = Json { prettyPrint = true }

    const val NOTE_ARBITRARY = "No real-world scale: coordinates are in the reconstruction's arbitrary units. " +
        "Importing apps will treat one unit as one metre, which is not the true size."

    /** What the export sheet says about units before exporting. */
    fun unitsStatement(scale: ScaleCalibration?): String = when {
        scale == null -> "No real-world scale — importing apps will treat units as metres; calibrate first for true size."
        scale.source == ScaleCalibration.Source.USER_REFERENCE -> "Exported in metres, using your reference calibration."
        else -> "Exported in metres, using the AR-estimated scale."
    }

    /** The mesh as it is written: multiplied by the scale when one exists (so that units are metres). */
    fun bakeScale(mesh: Mesh, scale: ScaleCalibration?): Mesh =
        if (scale == null) mesh else MeshOps.transform(mesh, Mat4.scale(scale.metersPerUnit.toFloat()))

    /**
     * `asset.extras` for an export: the original extras are carried over and
     * `pocket3d.scale` / `edited` / `edit_ops` / `exported_unix` / `export_transform` are replaced.
     */
    /** PLY has no metadata block: the unit statement goes into header comments. */
    fun plyComments(scale: ScaleCalibration?, doc: EditDocument): List<String> = buildList {
        if (scale != null) {
            add("units: meters (scale ${if (scale.source == ScaleCalibration.Source.USER_REFERENCE) "calibrated from a user reference" else "estimated from AR tracking"}, " +
                "relative uncertainty ${"%.3f".format(java.util.Locale.ROOT, scale.relativeUncertainty)})")
        } else {
            add("units: arbitrary (no real-world scale; photogrammetry alone does not determine size)")
        }
        if (doc.ops.any { it is EditOp.FillHoles }) add("contains repaired (synthetic, unphotographed) faces: see the face property 'repaired'")
    }

    fun buildExtras(original: JsonObject?, doc: EditDocument, scale: ScaleCalibration?, exportedUnix: Long): JsonObject {
        val originalP3 = original?.get("pocket3d") as? JsonObject
        val scaleObj = buildJsonObject {
            if (scale != null) {
                put("units", "meters")
                put("source", if (scale.source == ScaleCalibration.Source.USER_REFERENCE) "user_reference" else "ar_tracking")
                // Positions are already multiplied by the calibration, so one unit is one metre.
                put("meters_per_unit", 1.0)
                put("relative_uncertainty", scale.relativeUncertainty)
                put("note", if (scale.source == ScaleCalibration.Source.USER_REFERENCE)
                    "Scale from a user-marked reference distance, baked into the coordinates. One-sigma relative uncertainty as stated."
                else "Scale estimated from AR motion tracking during capture, baked into the coordinates. One-sigma relative uncertainty as stated.")
            } else {
                put("units", "arbitrary")
                put("source", "none")
                put("meters_per_unit", JsonNull)
                put("relative_uncertainty", JsonNull)
                put("note", NOTE_ARBITRARY)
            }
        }
        val current = doc.currentFromBase()
        val repaired = doc.ops.any { it is EditOp.FillHoles }
        val cropped = doc.ops.any { it is EditOp.Crop || it is EditOp.ClipPlane || it is EditOp.DeleteFaces }
        val p3 = buildJsonObject {
            // Statements about the ORIGINAL reconstruction must not be carried over once an edit
            // has made them untrue.
            originalP3?.forEach { (k, v) -> if (!(k == "suggested_crop" && cropped)) put(k, v) }
            if (repaired) {
                put("holes_preserved", false)
                put("repaired_note", "Holes were closed with synthetic surface on the phone (explicit repair). Those faces " +
                    "were not photographed; they use the material flagged pocket3d_repaired and have zero confidence.")
            }
            put("scale", scaleObj)
            put("edited", doc.ops.isNotEmpty())
            put("edit_ops", buildJsonArray { doc.ops.forEach { add(JsonPrimitive(it.label)) } })
            put("exported_unix", exportedUnix)
            put("export_transform", buildJsonObject {
                put("units_per_source_unit", scale?.metersPerUnit ?: 1.0)
                put("current_from_source", buildJsonArray { current.forEach { add(JsonPrimitive(it)) } })
                put("note", "Exported coordinates = units_per_source_unit · current_from_source (column-major 4x4) · source " +
                    "coordinates. suggested_crop, ground and frame above still refer to the source (reconstruction) frame.")
            })
        }
        return buildJsonObject {
            original?.forEach { (k, v) -> if (k != "pocket3d") put(k, v) }
            put("pocket3d", p3)
        }
    }

    /**
     * Number of vertices [GlbWriter] writes for [mesh]: one per distinct (material slot, vertex)
     * pair referenced by a face with finite coordinates. Also returns the number of faces written.
     */
    fun expectedGlbCounts(mesh: Mesh): Pair<Int, Int> {
        val pos = mesh.positions
        val idx = mesh.indices
        val vCount = mesh.vertexCount
        val matCount = mesh.materials.size
        val finite = BooleanArray(vCount) { pos[3 * it].isFinite() && pos[3 * it + 1].isFinite() && pos[3 * it + 2].isFinite() }
        // lastSlot[v] per slot would need slots × vertices bits; a hash set of slot*vCount+v is simpler and exact.
        val seen = HashSet<Long>(vCount * 2)
        var faces = 0
        for (f in 0 until mesh.faceCount) {
            val a = idx[3 * f]; val b = idx[3 * f + 1]; val c = idx[3 * f + 2]
            if (!(finite[a] && finite[b] && finite[c])) continue
            val m = mesh.materialOfFace(f)
            val slot = (if (m in 0 until matCount) m else matCount).toLong()
            seen.add(slot * vCount + a); seen.add(slot * vCount + b); seen.add(slot * vCount + c)
            faces++
        }
        return seen.size to faces
    }

    fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /** File-name stem made from a model/project name (safe on every file system, never empty). */
    fun safeBaseName(name: String): String {
        val cleaned = name.trim().map { if (it.isLetterOrDigit() || it == '-' || it == '_') it else '_' }.joinToString("")
            .replace(Regex("_+"), "_").trim('_')
        return cleaned.take(48).ifEmpty { "model" }
    }

    /**
     * @param mesh the current edited mesh (model units)
     * @param originalExtras `asset.extras` of the reconstruction's GLB
     * @param scale effective scale or null
     */
    fun build(format: ExportFormat, mesh: Mesh, originalExtras: JsonObject?, doc: EditDocument, scale: ScaleCalibration?,
              baseName: String, exportedUnix: Long, onStage: (String) -> Unit = {}): ExportArtifact {
        require(mesh.faceCount > 0) { "There is nothing to export: the model has no faces." }
        onStage(if (scale != null) "Applying scale" else "Preparing mesh")
        val out = bakeScale(mesh, scale)
        val extras = buildExtras(originalExtras, doc, scale, exportedUnix)
        val name = safeBaseName(baseName)
        onStage("Encoding ${format.label}")
        val bytes: ByteArray
        var zipEntries: List<String> = emptyList()
        when (format) {
            ExportFormat.GLB -> bytes = GlbWriter.write(GlbDocument(out, extras, GlbWriter.DEFAULT_GENERATOR))
            ExportFormat.PLY -> bytes = PlyWriter.write(out, plyComments(scale, doc))
            ExportFormat.OBJ_ZIP -> {
                val files = LinkedHashMap(ObjWriter.write(out, name))
                files["${name}_pocket3d.json"] = PrettyJson.encodeToString(JsonObject.serializer(), extras).toByteArray()
                files["README.txt"] = objReadme(scale).toByteArray()
                zipEntries = files.keys.toList()
                bytes = zip(files)
            }
        }
        val (v, f) = when (format) {
            ExportFormat.GLB -> expectedGlbCounts(out)
            else -> out.vertexCount to out.faceCount
        }
        return ExportArtifact(format, "$name.${format.extension}", bytes,
                              ExportArtifact.Expected(v, f, Aabb.of(out.positions), sha256(bytes), zipEntries),
                              metric = scale != null, unitsStatement = unitsStatement(scale))
    }

    private fun objReadme(scale: ScaleCalibration?): String = buildString {
        append("Exported by Pocket 3D Scanner.\n\n")
        append("Coordinates: right-handed, +Y up.\n")
        if (scale != null) append("Units: metres (scale baked in; one-sigma relative uncertainty ${scale.relativeUncertainty}).\n")
        else append("Units: ARBITRARY. ").append(NOTE_ARBITRARY).append('\n')
        append("Faces in a material/group named \"${MeshOps.REPAIRED_MATERIAL_NAME}\" are synthetic hole repairs and were not photographed.\n")
        append("OBJ cannot store the per-vertex evidence values; export GLB or PLY to keep them.\n")
    }

    private fun zip(files: Map<String, ByteArray>): ByteArray {
        val bos = ByteArrayOutputStream()
        ZipOutputStream(bos).use { z ->
            for ((name, data) in files) {
                z.putNextEntry(ZipEntry(name))
                z.write(data)
                z.closeEntry()
            }
        }
        return bos.toByteArray()
    }
}

/** Result of reading an export back from where it was written. */
sealed interface ExportCheck {
    data class Ok(val summary: String) : ExportCheck
    data class Failed(val reason: String) : ExportCheck
}

/**
 * Self-check after writing: the bytes that were actually stored are read back and compared with
 * what was meant to be written. A failed check is reported instead of claiming success.
 */
object ExportVerifier {
    fun verify(artifact: ExportArtifact, readBack: ByteArray): ExportCheck {
        val exp = artifact.expected
        if (readBack.size != artifact.bytes.size)
            return ExportCheck.Failed("The stored file has ${readBack.size} bytes but ${artifact.bytes.size} were written (incomplete write).")
        return when (artifact.format) {
            ExportFormat.GLB -> verifyGlb(exp, readBack)
            ExportFormat.OBJ_ZIP -> verifyZip(exp, readBack)
            ExportFormat.PLY -> verifyHash(exp, readBack, "${exp.vertexCount} vertices, ${exp.faceCount} faces")
        }
    }

    private fun verifyHash(exp: ExportArtifact.Expected, readBack: ByteArray, summary: String): ExportCheck =
        if (ExportBuilder.sha256(readBack) == exp.sha256) ExportCheck.Ok(summary)
        else ExportCheck.Failed("The stored file differs from what was written (checksum mismatch).")

    private fun verifyGlb(exp: ExportArtifact.Expected, readBack: ByteArray): ExportCheck {
        val doc = try {
            GlbReader.read(readBack)
        } catch (e: GlbFormatException) {
            return ExportCheck.Failed("The stored file cannot be read back as GLB: ${e.message}")
        }
        val m = doc.mesh
        if (m.faceCount != exp.faceCount)
            return ExportCheck.Failed("Read back ${m.faceCount} faces, expected ${exp.faceCount}.")
        if (m.vertexCount != exp.vertexCount)
            return ExportCheck.Failed("Read back ${m.vertexCount} vertices, expected ${exp.vertexCount}.")
        val b = Aabb.of(m.positions)
        val tol = max(exp.bounds.diagonal, 1e-12f) * 1e-5f
        fun close(x: Float, y: Float) = abs(x - y) <= tol
        val same = close(b.min.x, exp.bounds.min.x) && close(b.min.y, exp.bounds.min.y) && close(b.min.z, exp.bounds.min.z) &&
            close(b.max.x, exp.bounds.max.x) && close(b.max.y, exp.bounds.max.y) && close(b.max.z, exp.bounds.max.z)
        if (!same) return ExportCheck.Failed("Read-back bounds differ from the exported model.")
        // Geometry is right; the checksum additionally covers textures and metadata.
        return verifyHash(exp, readBack, "${m.vertexCount} vertices, ${m.faceCount} faces verified")
    }

    private fun verifyZip(exp: ExportArtifact.Expected, readBack: ByteArray): ExportCheck {
        val names = ArrayList<String>()
        try {
            ZipInputStream(readBack.inputStream()).use { z ->
                while (true) {
                    val e = z.nextEntry ?: break
                    // reading the entry validates its CRC
                    val buf = ByteArray(1 shl 16)
                    while (z.read(buf) >= 0) { /* drain */ }
                    names += e.name
                }
            }
        } catch (e: Exception) {
            return ExportCheck.Failed("The stored zip cannot be read back: ${e.message ?: e.javaClass.simpleName}")
        }
        if (names != exp.zipEntries)
            return ExportCheck.Failed("The stored zip contains ${names.size} files, expected ${exp.zipEntries.size}.")
        return verifyHash(exp, readBack, "${names.size} files, ${exp.faceCount} faces")
    }
}
