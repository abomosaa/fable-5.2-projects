package dev.pocket3d.viewer.data

import dev.pocket3d.core.edit.EditDocument
import dev.pocket3d.core.edit.EditEngine
import dev.pocket3d.core.edit.EditOp
import dev.pocket3d.core.mesh.GlbDocument
import dev.pocket3d.core.mesh.GlbFormatException
import dev.pocket3d.core.mesh.GlbReader
import dev.pocket3d.core.mesh.Mesh
import dev.pocket3d.core.project.CamerasDocument
import dev.pocket3d.core.project.ModelVersion
import dev.pocket3d.core.scale.ScaleCalibration
import dev.pocket3d.core.services.Services
import dev.pocket3d.viewer.measure.Measuring
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException

/** A load failure with a message that can be shown to the user as is. */
class ModelLoadException(val title: String, val detail: String, cause: Throwable? = null) : Exception("$title: $detail", cause)

/** Everything read from disk for one model. */
class LoadedModel(
    val model: ModelVersion,
    /** The immutable reconstruction result. */
    val glb: GlbDocument,
    val extras: ModelExtras,
    val doc: EditDocument,
    /** [glb] with the edits of [doc] applied. */
    val current: Mesh,
    /** Things the user should know (skipped edits, unreadable side files, reader warnings). */
    val notes: List<String>,
    val cameras: CamerasDocument?,
    val diagnostics: Diagnostics?,
    /** The reconstruction's own metric scale, if it has one. */
    val reconstructionScale: ScaleCalibration?,
)

/**
 * Keeps mesh snapshots for recent prefixes of the edit stack so that undo/redo do not have to
 * replay everything from the base mesh. Purely an optimisation: replaying is deterministic, so
 * the result is identical either way.
 */
class MeshHistory(private val base: Mesh, private val capacity: Int = 6) {
    private val entries = ArrayDeque<Pair<List<EditOp>, Mesh>>()

    fun remember(ops: List<EditOp>, mesh: Mesh) {
        entries.removeAll { it.first == ops }
        entries.addLast(ops to mesh)
        while (entries.size > capacity) entries.removeFirst()
    }

    /**
     * The mesh for [doc]: starts from the longest remembered prefix of its operations (or the
     * base mesh) and applies the rest. Returns the mesh and the notes of the replayed part.
     */
    fun meshFor(doc: EditDocument): EditEngine.Result {
        val ops = doc.ops
        var best: Pair<List<EditOp>, Mesh>? = null
        for (e in entries) {
            val p = e.first
            if (p.size <= ops.size && (best == null || p.size > best.first.size) && ops.subList(0, p.size) == p) best = e
        }
        val startMesh = best?.second ?: base
        val rest = ops.subList(best?.first?.size ?: 0, ops.size)
        if (rest.isEmpty()) return EditEngine.Result(startMesh, emptyList())
        val result = EditEngine.apply(startMesh, EditDocument(doc.baseSha256, rest))
        remember(ops, result.mesh)
        return result
    }
}

object ModelLoader {
    const val GLB_NAME = "model.glb"

    /**
     * Reads model.glb, the edit document and the side files of a model and applies the edits.
     * Main-safe. Never throws anything but [ModelLoadException] (and cancellation).
     */
    suspend fun load(projectId: String, modelId: String, onStage: (String) -> Unit = {}): LoadedModel {
        val store = try { Services.store } catch (e: UninitializedPropertyAccessException) {
            throw ModelLoadException("Storage is not available", "The app's project storage has not been started.", e)
        }
        onStage("Opening model…")
        val model = try { store.model(projectId, modelId) } catch (e: IOException) {
            throw ModelLoadException("The model could not be opened", e.message ?: "Reading the model record failed.", e)
        } ?: throw ModelLoadException("Model not found", "This model no longer exists in the project. It may have been deleted.")
        val dir = store.modelDir(projectId, modelId)
        val glbFile = File(dir, GLB_NAME)
        if (!glbFile.isFile) throw ModelLoadException("Model file missing", "The reconstruction result (model.glb) is not on this phone.")

        onStage("Reading geometry and textures…")
        val glb = withContext(Dispatchers.IO) { readGlb(glbFile) }
        val notes = ArrayList<String>()
        notes += glb.warnings

        var doc = try { store.loadEdits(projectId, modelId) } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            notes += "Saved edits could not be read and were ignored (${e.message ?: e.javaClass.simpleName}). The original model is shown."
            EditDocument(model.glbSha256)
        }
        if (doc.baseSha256.isNotEmpty() && model.glbSha256.isNotEmpty() && doc.baseSha256 != model.glbSha256) {
            notes += "Saved edits belong to a different model file and were not applied."
            doc = EditDocument(model.glbSha256)
        }

        onStage(if (doc.ops.isEmpty()) "Preparing model…" else "Applying ${doc.ops.size} saved edit${if (doc.ops.size == 1) "" else "s"}…")
        val applied = withContext(Dispatchers.Default) {
            try { EditEngine.apply(glb.mesh, doc) } catch (e: OutOfMemoryError) {
                throw ModelLoadException("Not enough memory", "The model is too large to edit on this device.")
            } catch (e: RuntimeException) {
                null
            }
        }
        val current: Mesh
        if (applied == null) {
            notes += "Saved edits could not be applied to this model and were ignored. The original model is shown."
            doc = EditDocument(model.glbSha256, scale = doc.scale, measurements = doc.measurements)
            current = glb.mesh
        } else {
            current = applied.mesh
            notes += applied.notes
        }

        val cameras = withContext(Dispatchers.IO) {
            val f = File(dir, "cameras.json")
            if (!f.isFile) null else try { CamerasJson.parse(f.readText()) } catch (e: Exception) {
                notes += "Camera positions (cameras.json) could not be read."; null
            }
        }
        val diagnostics = withContext(Dispatchers.IO) {
            val f = File(dir, "diagnostics.json")
            if (!f.isFile) null else try { Diagnostics.parse(f.readText()) } catch (e: Exception) {
                notes += "Reconstruction diagnostics could not be read."; null
            }
        }
        val extras = ModelExtras.parse(glb.extras)
        val recon = Measuring.reconstructionCalibration(model.reconstructionScale)
        return LoadedModel(model, glb, extras, doc, current, notes, cameras, diagnostics, recon)
    }

    /** Reads a GLB, translating every failure into a user-presentable [ModelLoadException]. */
    fun readGlb(file: File): GlbDocument = try {
        val doc = GlbReader.read(file)
        if (doc.mesh.faceCount == 0) throw ModelLoadException("Empty model", "The model file contains no surface.")
        doc
    } catch (e: GlbFormatException) {
        throw ModelLoadException("The model file is damaged", "It could not be read as a GLB model: ${e.message}", e)
    } catch (e: IOException) {
        throw ModelLoadException("The model file could not be read", e.message ?: "Reading from storage failed.", e)
    } catch (e: OutOfMemoryError) {
        throw ModelLoadException("Not enough memory", "The model is too large to open on this device.")
    }
}
