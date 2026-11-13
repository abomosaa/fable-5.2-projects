package dev.pocket3d.data

import dev.pocket3d.core.edit.EditDocument
import dev.pocket3d.core.edit.EditOp
import dev.pocket3d.core.project.CaptureSource
import dev.pocket3d.core.project.DeviceInfo
import dev.pocket3d.core.project.Frame
import dev.pocket3d.core.project.FrameFlag
import dev.pocket3d.core.project.JobEvent
import dev.pocket3d.core.project.JobPhase
import dev.pocket3d.core.project.ReconJob
import dev.pocket3d.core.project.TrackingInfo
import dev.pocket3d.core.project.TrackingSegment
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.util.zip.ZipEntry
import java.util.zip.ZipFile

class FileProjectStoreTest {
    @get:Rule val tmp = TemporaryFolder()

    private lateinit var root: File
    private var now = 1_000_000L
    private var free = 10L * 1024 * 1024 * 1024
    private val png = byteArrayOf(0x89.toByte(), 'P'.code.toByte(), 'N'.code.toByte(), 'G'.code.toByte(), 13, 10, 26, 10, 1, 2, 3)

    @Before fun setUp() { root = File(tmp.root, "projects") }

    /** A new instance on the same directory is what the app sees after a process restart. */
    private fun open() = FileProjectStore(root, clock = { ++now }, freeSpace = { free })

    private fun sessionDir(pid: String, sid: String) = File(root, "$pid/sessions/$sid")

    private suspend fun FileProjectStore.completedModel(pid: String, sid: String, glb: ByteArray = randomBytes(4000, 7),
                                                        stats: ModelStats = ModelStats(vertexCount = 10, faceCount = 20)): Pair<ReconJob, String> {
        val job = createJob(pid, sid, "preview", listOf("a"), 100, "srv", "PC")
        driveToDownloading(job)
        val dl = File(jobDir(pid, job.id), "download").apply { mkdirs() }
        val files = mapOf("model.glb" to File(dl, "model.glb").apply { writeBytes(glb) },
            "cameras.json" to File(dl, "cameras.json").apply { writeText("{}") },
            "diagnostics.json" to File(dl, "diagnostics.json").apply { writeText("{}") })
        val model = registerCompletedModel(pid, job.id, files, StorageFiles.sha256(glb), glb.size.toLong(), stats)
        return job to model.id
    }

    // ---- persistence -------------------------------------------------------------------------

    @Test fun projectSessionAndFramesSurviveRestart() = runBlocking {
        val store = open()
        val p = store.createProject("  Garden gnome  ")
        assertEquals("Garden gnome", p.name)
        val s = store.createSession(p.id, CaptureSource.CAMERA_AR, DeviceInfo("Google", "Pixel 8", 35))
        val a = store.addFrame(p.id, s.id, "a", randomBytes(3000, 1))
        store.addFrame(p.id, s.id, "b", randomBytes(2000, 2))
        store.addFrame(p.id, s.id, "c", randomBytes(1000, 3), format = "png")
        store.updateFrame(p.id, s.id, "b") { it.copy(excluded = true, flags = listOf(FrameFlag.BLUR)) }
        store.updateSessionMeta(p.id, s.id, TrackingInfo("arcore", listOf(TrackingSegment(0, listOf("a", "b", "c")))), listOf(0.0, 0.1, -0.5))
        store.renameProject(p.id, "Gnome v2")

        val re = open()
        assertTrue(re.recoveryNotes.isEmpty())
        val p2 = re.project(p.id)!!
        assertEquals("Gnome v2", p2.name)
        assertEquals(listOf(s.id), p2.sessionIds)
        val s2 = re.session(p.id, s.id)!!
        assertEquals(store.session(p.id, s.id), s2)
        assertEquals(listOf("a", "b", "c"), s2.frames.map { it.id })
        assertEquals(listOf("a.jpg", "b.jpg", "c.png"), s2.frames.map { it.file })
        assertTrue(s2.frames[1].excluded)
        assertEquals("arcore", s2.tracking.mode)
        assertEquals(listOf(0.0, 0.1, -0.5), s2.objectCenterAr)
        assertEquals(CaptureSource.CAMERA_AR, s2.source)
        assertEquals(a, s2.frames[0])
        assertArrayEquals(randomBytes(3000, 1), re.frameFile(p.id, s.id, s2.frames[0]).readBytes())

        val row = re.summaries.value.single()
        assertEquals(2, row.frameCount)                       // excluded frame not counted
        assertTrue(row.diskBytes >= 6000)
        assertNull(row.latestJobPhase)
        assertFalse(row.hasModel)
        assertEquals(p2, re.observeProject(p.id).first())
        assertEquals(s2, re.observeSession(p.id, s.id).first())
    }

    @Test fun summariesAreNewestFirstAndFollowMutations() = runBlocking {
        val store = open()
        val a = store.createProject("A")
        val b = store.createProject("B")
        assertEquals(listOf("B", "A"), store.summaries.value.map { it.project.name })
        val s = store.createSession(a.id, CaptureSource.IMPORT, DeviceInfo())
        store.addFrame(a.id, s.id, "x", randomBytes(500, 1))
        assertEquals(listOf("A", "B"), store.summaries.value.map { it.project.name })
        assertEquals(1, store.summaries.value.first().frameCount)
        store.removeFrame(a.id, s.id, "x")
        assertEquals(0, store.summaries.value.first().frameCount)
        store.deleteProject(b.id)
        assertEquals(listOf("A"), store.summaries.value.map { it.project.name })
    }

    // ---- commitFrame -------------------------------------------------------------------------

    @Test fun commitFrameHashesMovesAndNamesTheFile() = runBlocking {
        val store = open()
        val p = store.createProject("p")
        val s = store.createSession(p.id, CaptureSource.CAMERA, DeviceInfo())
        val bytes = randomBytes(70_000, 42)
        val temp = store.newFrameTempFile(p.id, s.id)
        temp.writeBytes(bytes)
        val stored = store.commitFrame(p.id, s.id,
            Frame(id = "0001", name = "../../etc/passwd", file = "ignored-by-store", format = "jpeg", sizeBytes = 1, sha256 = "bogus"), temp)
        assertEquals("0001.jpg", stored.file)
        assertEquals(70_000L, stored.sizeBytes)
        assertEquals(StorageFiles.sha256(bytes), stored.sha256)
        assertEquals("../../etc/passwd", stored.name)     // display name is metadata only
        assertFalse(temp.exists())
        val file = store.frameFile(p.id, s.id, stored)
        assertEquals(File(sessionDir(p.id, s.id), "frames/0001.jpg").canonicalFile, file.canonicalFile)
        assertArrayEquals(bytes, file.readBytes())
        assertEquals(listOf("0001.jpg"), File(sessionDir(p.id, s.id), "frames").list()!!.toList())
    }

    @Test fun commitFrameRejectsUnsafeIdsFormatsAndForeignFiles() = runBlocking {
        val store = open()
        val p = store.createProject("p")
        val s = store.createSession(p.id, CaptureSource.CAMERA, DeviceInfo())
        suspend fun expectRejected(frame: Frame, temp: File = store.newFrameTempFile(p.id, s.id).apply { writeBytes(randomBytes(10, 1)) }) {
            try { store.commitFrame(p.id, s.id, frame, temp); fail("accepted $frame") } catch (_: IllegalArgumentException) { }
        }
        expectRejected(Frame(id = "../x", name = "n", file = ""))
        expectRejected(Frame(id = "a/b", name = "n", file = ""))
        expectRejected(Frame(id = "", name = "n", file = ""))
        expectRejected(Frame(id = "x".repeat(33), name = "n", file = ""))
        expectRejected(Frame(id = "ok", name = "n", file = "", format = "gif"))
        expectRejected(Frame(id = "ok", name = "n", file = "", format = "../jpeg"))
        expectRejected(Frame(id = "ok", name = "n", file = ""), File(tmp.root, "outside.tmp").apply { writeBytes(randomBytes(10, 1)) })
        store.addFrame(p.id, s.id, "ok", randomBytes(10, 2))
        expectRejected(Frame(id = "ok", name = "again", file = ""))
        assertEquals(listOf("ok"), store.session(p.id, s.id)!!.frames.map { it.id })
        try { store.frameFile(p.id, s.id, Frame(id = "ok", name = "n", file = "../../project.json")); fail() } catch (_: IllegalArgumentException) { }
        try { store.modelDir(p.id, "../.."); fail() } catch (_: IllegalArgumentException) { }
        try { store.jobDir("..", Ids.newUuid()); fail() } catch (_: IllegalArgumentException) { }
    }

    @Test fun frameEditingOperations() = runBlocking {
        val store = open()
        val p = store.createProject("p")
        val s = store.createSession(p.id, CaptureSource.IMPORT, DeviceInfo())
        for (id in listOf("a", "b", "c", "d")) store.addFrame(p.id, s.id, id, randomBytes(100, id.hashCode().toLong()))
        store.reorderFrames(p.id, s.id, listOf("c", "a", "zzz", "c"), "manual")
        var ses = store.session(p.id, s.id)!!
        assertEquals(listOf("c", "a", "b", "d"), ses.frames.map { it.id })   // unlisted frames are kept, never dropped
        assertEquals("manual", ses.ordering)
        // identity and byte facts cannot be changed through updateFrame
        store.updateFrame(p.id, s.id, "a") { it.copy(id = "hacked", file = "x.jpg", sha256 = "0", sizeBytes = 5, name = "renamed") }
        ses = store.session(p.id, s.id)!!
        val a = ses.frames.first { it.name == "renamed" }
        assertEquals("a", a.id); assertEquals("a.jpg", a.file); assertEquals(100L, a.sizeBytes)
        val fileB = store.frameFile(p.id, s.id, ses.frames.first { it.id == "b" })
        store.removeFrame(p.id, s.id, "b")
        assertFalse(fileB.exists())
        assertEquals(listOf("c", "a", "d"), open().session(p.id, s.id)!!.frames.map { it.id })
        store.deleteSession(p.id, s.id)
        assertFalse(sessionDir(p.id, s.id).exists())
        assertTrue(open().sessions(p.id).isEmpty())
    }

    // ---- crash recovery ----------------------------------------------------------------------

    @Test fun tornSessionJsonFallsBackToPreviousVersionAndReadoptsThePhoto() = runBlocking {
        val store = open()
        val p = store.createProject("p")
        val s = store.createSession(p.id, CaptureSource.CAMERA, DeviceInfo())
        store.addFrame(p.id, s.id, "a", randomBytes(900, 1))
        val b = store.addFrame(p.id, s.id, "b", randomBytes(800, 2))
        // Power loss half-way through a (non-atomic) overwrite of session.json:
        val sessionJson = File(sessionDir(p.id, s.id), "session.json")
        val text = sessionJson.readText()
        sessionJson.writeText(text.substring(0, text.length / 2))

        val re = open()
        val ses = re.session(p.id, s.id)!!
        assertEquals(setOf("a", "b"), ses.frames.map { it.id }.toSet())      // no committed frame is lost
        val a2 = ses.frames.first { it.id == "a" }
        assertEquals(1_700_000_000_000, a2.timestampMs)                       // from the last good version
        assertFalse(FrameFlag.NO_METADATA in a2.flags)
        val b2 = ses.frames.first { it.id == "b" }                            // only in the torn version → re-adopted
        assertTrue(FrameFlag.NO_METADATA in b2.flags)
        assertEquals(b.sha256, b2.sha256); assertEquals(b.sizeBytes, b2.sizeBytes); assertEquals("b.jpg", b2.file)
        assertTrue(re.recoveryNotes.isNotEmpty())
        // and the repaired state is itself durable
        assertEquals(ses, open().session(p.id, s.id))
        assertEquals(ses, Json { ignoreUnknownKeys = true }.decodeFromString(dev.pocket3d.core.project.CaptureSession.serializer(), sessionJson.readText()))
    }

    @Test fun missingSessionJsonKeepsFramesFlaggedNoMetadata() = runBlocking {
        val store = open()
        val p = store.createProject("p")
        val s = store.createSession(p.id, CaptureSource.CAMERA, DeviceInfo())
        val a = store.addFrame(p.id, s.id, "a", randomBytes(900, 1))
        val c = store.addFrame(p.id, s.id, "c", randomBytes(700, 3), format = "heic")
        File(sessionDir(p.id, s.id), "session.json").delete()
        File(sessionDir(p.id, s.id), "session.json.bak").delete()

        val re = open()
        val ses = re.session(p.id, s.id)!!
        assertEquals(listOf("a", "c"), ses.frames.map { it.id })
        assertTrue(ses.frames.all { FrameFlag.NO_METADATA in it.flags })
        assertEquals(listOf(a.sha256, c.sha256), ses.frames.map { it.sha256 })
        assertEquals(listOf("jpeg", "heic"), ses.frames.map { it.format })
        assertTrue(re.frameFile(p.id, s.id, ses.frames[0]).isFile)
        assertEquals(2, re.summaries.value.single().frameCount)
        assertTrue(re.recoveryNotes.any { "session.json" in it })
    }

    @Test fun orphanTempFilesAreDeletedAndNeverReadAsValid() = runBlocking {
        val store = open()
        val p = store.createProject("real name")
        val s = store.createSession(p.id, CaptureSource.CAMERA, DeviceInfo())
        store.addFrame(p.id, s.id, "a", randomBytes(900, 1))
        val orphan = store.newFrameTempFile(p.id, s.id).apply { writeBytes(randomBytes(5000, 9)) }   // capture died before commit
        val frames = File(sessionDir(p.id, s.id), "frames")
        val partial = File(frames, "b.jpg.tmp").apply { writeBytes(randomBytes(10, 1)) }
        // complete-looking but uncommitted metadata written by a crashed atomic write
        val projTmp = File(root, "${p.id}/project.json.deadbeef.tmp")
        projTmp.writeText(File(root, "${p.id}/project.json").readText().replace("real name", "evil name"))
        val sesTmp = File(sessionDir(p.id, s.id), "session.json.1.tmp").apply { writeText("{\"id\":") }

        val re = open()
        assertFalse(orphan.exists()); assertFalse(partial.exists()); assertFalse(projTmp.exists()); assertFalse(sesTmp.exists())
        assertEquals("real name", re.project(p.id)!!.name)
        assertEquals(listOf("a"), re.session(p.id, s.id)!!.frames.map { it.id })
        assertEquals(listOf("a.jpg"), frames.list()!!.toList())
        assertTrue(re.recoveryNotes.isEmpty())
    }

    @Test fun frameWhoseFileVanishedIsDroppedFromMetadataNotInvented() = runBlocking {
        val store = open()
        val p = store.createProject("p")
        val s = store.createSession(p.id, CaptureSource.CAMERA, DeviceInfo())
        store.addFrame(p.id, s.id, "a", randomBytes(900, 1))
        val b = store.addFrame(p.id, s.id, "b", randomBytes(900, 2))
        store.frameFile(p.id, s.id, b).delete()     // crash inside removeFrame: file gone, metadata not yet rewritten
        val re = open()
        assertEquals(listOf("a"), re.session(p.id, s.id)!!.frames.map { it.id })
    }

    @Test fun corruptProjectJsonIsRestoredFromBackupOrRebuilt() = runBlocking {
        val store = open()
        val p = store.createProject("first")
        val s = store.createSession(p.id, CaptureSource.CAMERA, DeviceInfo())
        store.addFrame(p.id, s.id, "a", randomBytes(900, 1))
        store.renameProject(p.id, "second")
        val projectJson = File(root, "${p.id}/project.json")
        projectJson.writeText("{ not json")
        var re = open()
        assertEquals("first", re.project(p.id)!!.name)                 // last good version
        assertEquals(listOf(s.id), re.project(p.id)!!.sessionIds)
        assertEquals(1, re.session(p.id, s.id)!!.frames.size)

        projectJson.delete(); File(root, "${p.id}/project.json.bak").delete()
        re = open()
        assertEquals("Recovered project", re.project(p.id)!!.name)     // photos are never orphaned
        assertEquals(listOf(s.id), re.project(p.id)!!.sessionIds)
        assertEquals(1, re.summaries.value.single().frameCount)
    }

    // ---- storage guard -----------------------------------------------------------------------

    @Test fun lowStorageGuardFailsWithTypedErrorAndChangesNothing() = runBlocking {
        val store = open()
        val p = store.createProject("p")
        val s = store.createSession(p.id, CaptureSource.CAMERA, DeviceInfo())
        store.addFrame(p.id, s.id, "a", randomBytes(200_000, 1))
        val (_, modelId) = store.completedModel(p.id, s.id)

        free = 10L * 1024 * 1024          // below the 50 MB reserve
        val temp = store.newFrameTempFile(p.id, s.id).apply { writeBytes(randomBytes(1000, 2)) }
        try {
            store.commitFrame(p.id, s.id, Frame(id = "b", name = "b", file = ""), temp); fail()
        } catch (e: InsufficientStorageException) {
            assertEquals(free, e.freeBytes)
            assertTrue(e.requiredBytes > 0)
        }
        assertFalse(temp.exists())
        assertEquals(listOf("a"), store.session(p.id, s.id)!!.frames.map { it.id })

        // exactly at the boundary: required + reserve must be available
        // photo bytes + everything in the model directory (model.glb, cameras/diagnostics json, model record)
        val projectBytes = 200_000L + StorageFiles.dirSize(store.modelDir(p.id, modelId))
        free = FileProjectStore.RESERVE_BYTES + projectBytes - 1
        try { store.duplicateProject(p.id); fail() } catch (e: InsufficientStorageException) { assertEquals(projectBytes, e.requiredBytes) }
        assertEquals(1, store.summaries.value.size)
        assertEquals(listOf(p.id), root.list()!!.toList())           // no half copy left behind
        try { store.exportProjectArchive(p.id, ByteArrayOutputStream()); fail() } catch (_: InsufficientStorageException) { }
        free = FileProjectStore.RESERVE_BYTES - 1      // a thumbnail is tiny: only the reserve itself can block it
        try { store.saveThumbnail(p.id, modelId, png); fail() } catch (_: InsufficientStorageException) { }

        free = FileProjectStore.RESERVE_BYTES + 10L * 1024 * 1024
        assertNotNull(store.duplicateProject(p.id))
        assertEquals(free, store.freeBytes())
    }

    // ---- duplicate / delete / export ---------------------------------------------------------

    @Test fun duplicateProjectDeepCopiesPhotosModelsAndEditsButNotJobs() = runBlocking {
        val store = open()
        val p = store.createProject("Vase")
        val s = store.createSession(p.id, CaptureSource.IMPORT, DeviceInfo())
        store.addFrame(p.id, s.id, "a", randomBytes(900, 1))
        store.addFrame(p.id, s.id, "b", randomBytes(800, 2))
        val glb = randomBytes(4000, 7)
        val (_, modelId) = store.completedModel(p.id, s.id, glb)
        val edits = EditDocument(baseSha256 = StorageFiles.sha256(glb)).push(EditOp.KeepLargest(1))
        store.saveEdits(p.id, modelId, edits)
        store.saveThumbnail(p.id, modelId, png)

        val copy = store.duplicateProject(p.id)
        assertNotEquals(p.id, copy.id)
        assertEquals("Vase copy", copy.name)
        assertTrue(copy.jobIds.isEmpty()); assertTrue(store.jobs(copy.id).isEmpty())
        assertFalse(File(root, "${copy.id}/jobs").exists())
        val cs = store.sessions(copy.id).single()
        assertNotEquals(s.id, cs.id); assertEquals(copy.id, cs.projectId)
        assertEquals(store.session(p.id, s.id)!!.frames, cs.frames)
        val cm = store.models(copy.id).single()
        assertNotEquals(modelId, cm.id); assertEquals(cs.id, cm.sessionId); assertEquals(cm.id, copy.activeModelId)
        assertArrayEquals(glb, File(store.modelDir(copy.id, cm.id), "model.glb").readBytes())
        assertEquals(edits, store.loadEdits(copy.id, cm.id))
        assertNotNull(store.summaries.value.first { it.project.id == copy.id }.thumbnailPath)

        // really independent: deleting the original leaves the copy intact, also after a restart
        store.deleteProject(p.id)
        assertFalse(File(root, p.id).exists())
        val re = open()
        assertNull(re.project(p.id))
        assertArrayEquals(randomBytes(900, 1), re.frameFile(copy.id, cs.id, cs.frames[0]).readBytes())
        assertEquals(edits, re.loadEdits(copy.id, cm.id))
        assertEquals(listOf(copy.id), re.summaries.value.map { it.project.id })
    }

    @Test fun deletionPlanCountsLocalDataAndDeleteRemovesEverything() = runBlocking {
        val store = open()
        val p = store.createProject("Shoe")
        val s = store.createSession(p.id, CaptureSource.IMPORT, DeviceInfo())
        store.addFrame(p.id, s.id, "a", randomBytes(900, 1))
        store.addFrame(p.id, s.id, "b", randomBytes(800, 2))
        store.updateFrame(p.id, s.id, "b") { it.copy(excluded = true) }
        store.completedModel(p.id, s.id)
        val plan = store.deletionPlan(p.id)
        assertEquals("Shoe", plan.projectName)
        assertEquals(2, plan.photoCount)                  // excluded photos are deleted too
        assertEquals(1700L, plan.photoBytes)
        assertEquals(1, plan.modelCount)
        assertTrue(plan.modelBytes >= 4004)
        assertTrue(plan.totalBytes >= plan.photoBytes + plan.modelBytes)
        assertEquals(StorageFiles.dirSize(File(root, p.id)), plan.totalBytes)
        assertTrue(plan.companionSessionIds.isEmpty()); assertNull(plan.companionName); assertFalse(plan.companionReachable)

        store.deleteProject(p.id)
        assertNull(store.project(p.id))
        assertTrue(store.summaries.value.isEmpty())
        assertTrue(root.list()!!.isEmpty())
        assertTrue(open().summaries.value.isEmpty())
    }

    @Test fun interruptedDeleteIsFinishedOnNextStart() = runBlocking {
        val store = open()
        val p = store.createProject("p")
        // crash after the rename that hides the project, before its bytes were removed
        File(root, p.id).renameTo(File(root, ".deleted-${p.id}-1"))
        File(root, ".staging-${Ids.newUuid()}").mkdirs()       // crash in the middle of duplicateProject
        val re = open()
        assertTrue(re.summaries.value.isEmpty())
        assertTrue(root.list()!!.isEmpty())
    }

    @Test fun exportArchiveHasManifestRelativePathsStoredPhotosAndVerifiableChecksums() = runBlocking {
        val store = open()
        val p = store.createProject("Export me")
        val s = store.createSession(p.id, CaptureSource.IMPORT, DeviceInfo())
        store.addFrame(p.id, s.id, "a", randomBytes(30_000, 1))
        store.addFrame(p.id, s.id, "b", randomBytes(20_000, 2), format = "webp")
        val glb = randomBytes(4000, 7)
        val (_, modelId) = store.completedModel(p.id, s.id, glb)
        store.saveEdits(p.id, modelId, EditDocument(baseSha256 = StorageFiles.sha256(glb)).push(EditOp.KeepLargest(1)))
        store.saveThumbnail(p.id, modelId, png)

        val zipFile = File(tmp.root, "out.zip")
        val progress = ArrayList<Float>()
        zipFile.outputStream().use { store.exportProjectArchive(p.id, it) { f -> progress += f } }
        assertEquals(1f, progress.last())
        assertTrue(progress.zipWithNext().all { (x, y) -> y >= x })

        ZipFile(zipFile).use { zip ->
            val entries = zip.entries().toList()
            assertEquals("manifest.json", entries.first().name)
            for (e in entries) {
                assertFalse(e.name, e.name.startsWith("/") || e.name.contains("..") || e.name.contains("\\") || e.name.contains(":"))
            }
            val manifest = Json.decodeFromString(ArchiveManifest.serializer(), zip.getInputStream(entries.first()).readBytes().decodeToString())
            assertEquals(ArchiveManifest.KIND, manifest.kind)
            assertEquals(1, manifest.format)
            assertEquals("Export me", manifest.project.name)
            assertEquals(listOf(s.id), manifest.sessions.map { it.id })
            assertEquals(listOf("a", "b"), manifest.sessions.single().frames.map { it.id })
            assertEquals(listOf(modelId), manifest.models.map { it.id })
            // every listed file is in the archive with exactly the listed bytes — and nothing else is
            assertEquals(manifest.files.map { it.path }.toSet(), entries.drop(1).map { it.name }.toSet())
            for (f in manifest.files) {
                val bytes = zip.getInputStream(zip.getEntry(f.path)).readBytes()
                assertEquals(f.path, f.size, bytes.size.toLong())
                assertEquals(f.path, f.sha256, StorageFiles.sha256(bytes))
            }
            val names = manifest.files.map { it.path }.toSet()
            assertTrue(names.containsAll(listOf("project.json", "sessions/${s.id}/session.json", "sessions/${s.id}/frames/a.jpg",
                "sessions/${s.id}/frames/b.webp", "models/$modelId/model.glb", "models/$modelId/model.json",
                "models/$modelId/cameras.json", "models/$modelId/diagnostics.json", "models/$modelId/edits.json",
                "models/$modelId/thumbnail.png")))
            assertTrue(names.none { it.startsWith("jobs/") })
            // photos and models are stored, not deflated
            for (n in listOf("sessions/${s.id}/frames/a.jpg", "sessions/${s.id}/frames/b.webp", "models/$modelId/model.glb")) {
                val e = zip.getEntry(n)
                assertEquals(n, ZipEntry.STORED, e.method)
                assertEquals(n, e.size, e.compressedSize)
            }
            assertArrayEquals(randomBytes(30_000, 1), zip.getInputStream(zip.getEntry("sessions/${s.id}/frames/a.jpg")).readBytes())
        }
    }

    // ---- edits + thumbnail -------------------------------------------------------------------

    @Test fun editsPersistAndAreNeverReturnedForADifferentModel() = runBlocking {
        val store = open()
        val p = store.createProject("p")
        val s = store.createSession(p.id, CaptureSource.IMPORT, DeviceInfo())
        store.addFrame(p.id, s.id, "a", randomBytes(900, 1))
        val glb = randomBytes(4000, 7)
        val sha = StorageFiles.sha256(glb)
        val (_, modelId) = store.completedModel(p.id, s.id, glb)

        assertEquals(EditDocument(baseSha256 = sha), store.loadEdits(p.id, modelId))     // nothing saved yet
        val edits = EditDocument(baseSha256 = sha).push(EditOp.KeepLargest(2)).push(EditOp.Simplify(5000)).undo()
        store.saveEdits(p.id, modelId, edits)
        assertEquals(edits, store.loadEdits(p.id, modelId))
        assertEquals(edits, open().loadEdits(p.id, modelId))
        assertTrue(edits.canUndo && edits.canRedo)

        // edits made for other bytes are refused on save …
        try { store.saveEdits(p.id, modelId, edits.copy(baseSha256 = "f".repeat(64))); fail() } catch (_: IllegalArgumentException) { }
        assertEquals(edits, store.loadEdits(p.id, modelId))
        // … and if such a file ends up on disk anyway it is not applied
        val editsFile = File(store.modelDir(p.id, modelId), "edits.json")
        editsFile.writeText(editsFile.readText().replace(sha, "f".repeat(64)))
        File(store.modelDir(p.id, modelId), "edits.json.bak").delete()
        assertEquals(EditDocument(baseSha256 = sha), open().loadEdits(p.id, modelId))
        // a torn edits.json falls back to the previous save
        store.saveEdits(p.id, modelId, edits)
        val newer = edits.push(EditOp.KeepLargest(1))
        store.saveEdits(p.id, modelId, newer)
        editsFile.writeText("{\"baseSha256\":\"")
        assertEquals(edits, open().loadEdits(p.id, modelId))
    }

    @Test fun thumbnailIsStoredAndPublishedForTheActiveModel() = runBlocking {
        val store = open()
        val p = store.createProject("p")
        val s = store.createSession(p.id, CaptureSource.IMPORT, DeviceInfo())
        val (_, modelId) = store.completedModel(p.id, s.id)
        assertNull(store.summaries.value.single().thumbnailPath)
        try { store.saveThumbnail(p.id, modelId, "not a png".toByteArray()); fail() } catch (_: IllegalArgumentException) { }
        store.saveThumbnail(p.id, modelId, png)
        val path = store.summaries.value.single().thumbnailPath!!
        assertEquals(File(store.modelDir(p.id, modelId), "thumbnail.png").absolutePath, path)
        assertArrayEquals(png, File(path).readBytes())
        assertEquals(path, open().summaries.value.single().thumbnailPath)
    }

    // ---- jobs + models -----------------------------------------------------------------------

    @Test fun jobRecordsAreDurableAndPhaseOnlyMovesThroughTheStateMachine() = runBlocking {
        val store = open()
        val p = store.createProject("p")
        val s = store.createSession(p.id, CaptureSource.IMPORT, DeviceInfo())
        val job = store.createJob(p.id, s.id, "standard", listOf("a", "b"), 1234, "srv-1", "Workstation")
        assertTrue(Ids.UUID4.matches(job.id))
        assertEquals(JobPhase.PENDING, job.phase)
        assertEquals(JobPhase.PENDING, store.summaries.value.single().latestJobPhase)

        // a transform cannot set a phase; only events can
        val sneaky = store.updateJob(p.id, job.id) { j, _ -> j.copy(phase = JobPhase.COMPLETED, uploadedBytes = 10) }!!
        assertEquals(JobPhase.PENDING, sneaky.phase); assertEquals(10L, sneaky.uploadedBytes)
        // an event that does not apply leaves the phase alone (COMPLETED needs DOWNLOADING + verification)
        assertEquals(JobPhase.PENDING, store.updateJob(p.id, job.id, JobEvent.ResultsVerified)!!.phase)
        var changedSeen = false
        val up = store.updateJob(p.id, job.id, JobEvent.UploadStarted) { j, changed -> changedSeen = changed; j.copy(uploadedBytes = 617) }!!
        assertTrue(changedSeen); assertEquals(JobPhase.UPLOADING, up.phase)
        assertEquals(0.5f, store.summaries.value.single().latestJobProgress, 0.01f)

        val re = open()
        assertEquals(up, re.job(p.id, job.id))
        assertEquals(listOf(up), re.jobs(p.id)); assertEquals(listOf(up), re.allJobs())
        assertEquals(up, re.observeJob(p.id, job.id).first())
        assertEquals(JobPhase.UPLOADING, re.summaries.value.single().latestJobPhase)
        assertNull(re.updateJob(p.id, Ids.newUuid(), JobEvent.UploadStarted))
        re.deleteJobRecord(p.id, job.id)
        assertNull(re.job(p.id, job.id)); assertFalse(re.jobDir(p.id, job.id).exists())
        assertTrue(open().jobs(p.id).isEmpty())
    }

    @Test fun activeModelChangesOnlyWhenAVerifiedResultIsRegistered() = runBlocking {
        val store = open()
        val p = store.createProject("p")
        val s = store.createSession(p.id, CaptureSource.IMPORT, DeviceInfo())
        store.addFrame(p.id, s.id, "a", randomBytes(900, 1))
        val glbA = randomBytes(4000, 7)
        val (jobA, modelA) = store.completedModel(p.id, s.id, glbA, ModelStats(vertexCount = 11, faceCount = 22, textureBytes = 33, registeredCameras = 4, inputFrames = 5))
        assertEquals(modelA, store.project(p.id)!!.activeModelId)
        assertEquals(JobPhase.COMPLETED, store.job(p.id, jobA.id)!!.phase)
        assertEquals(modelA, store.job(p.id, jobA.id)!!.modelId)
        val mA = store.model(p.id, modelA)!!
        assertEquals(StorageFiles.sha256(glbA), mA.glbSha256); assertEquals(4000L, mA.glbBytes)
        assertEquals(listOf(11, 22, 4, 5), listOf(mA.vertexCount, mA.faceCount, mA.registeredCameras, mA.inputFrames))
        assertEquals(setOf("model.glb", "cameras.json", "diagnostics.json", "model.json"), store.modelDir(p.id, modelA).list()!!.toSet())
        assertTrue(store.summaries.value.single().hasModel)

        // a second job that is merely "succeeded on the companion" changes nothing …
        val jobB = store.createJob(p.id, s.id, "high", listOf("a"), 100, "srv", "PC")
        store.driveToDownloading(jobB)
        assertEquals(modelA, store.project(p.id)!!.activeModelId)
        // … a damaged download is refused …
        val bad = File(tmp.root, "bad.glb").apply { writeBytes(randomBytes(4000, 8)) }
        try {
            store.registerCompletedModel(p.id, jobB.id, mapOf("model.glb" to bad), StorageFiles.sha256(randomBytes(4000, 9)), 4000, ModelStats()); fail()
        } catch (_: IOException) { }
        assertEquals(modelA, store.project(p.id)!!.activeModelId)
        assertEquals(listOf(modelA), store.models(p.id).map { it.id })
        assertEquals(JobPhase.DOWNLOADING, store.job(p.id, jobB.id)!!.phase)
        // … and so is the result of a job that failed or was cancelled in the meantime
        store.updateJob(p.id, jobB.id, JobEvent.TransferFailed(permanent = true))
        try {
            store.registerCompletedModel(p.id, jobB.id, mapOf("model.glb" to bad), StorageFiles.sha256(bad.readBytes()), 4000, ModelStats()); fail()
        } catch (_: IllegalStateException) { }
        val jobC = store.createJob(p.id, s.id, "high", listOf("a"), 100, "srv", "PC")
        store.driveToDownloading(jobC)
        store.updateJob(p.id, jobC.id, JobEvent.CancelRequested)
        try {
            store.registerCompletedModel(p.id, jobC.id, mapOf("model.glb" to bad), StorageFiles.sha256(bad.readBytes()), 4000, ModelStats()); fail()
        } catch (_: IllegalStateException) { }
        var re = open()
        assertEquals(modelA, re.project(p.id)!!.activeModelId)
        assertEquals(listOf(modelA), re.models(p.id).map { it.id })
        assertArrayEquals(glbA, File(re.modelDir(p.id, modelA), "model.glb").readBytes())
        assertEquals(listOf(modelA), File(root, "${p.id}/models").list()!!.toList())

        // the next verified result becomes active; the old model stays available and untouched
        val (_, modelD) = re.completedModel(p.id, s.id, randomBytes(3000, 10))
        assertEquals(modelD, re.project(p.id)!!.activeModelId)
        assertEquals(listOf(modelA, modelD), re.models(p.id).map { it.id })
        assertArrayEquals(glbA, File(re.modelDir(p.id, modelA), "model.glb").readBytes())
        re.setActiveModel(p.id, modelA)
        re = open()
        assertEquals(modelA, re.project(p.id)!!.activeModelId)
        re.deleteModel(p.id, modelA)
        assertEquals(modelD, re.project(p.id)!!.activeModelId)
        assertFalse(re.modelDir(p.id, modelA).exists())
        try { re.setActiveModel(p.id, modelA); fail() } catch (_: IllegalArgumentException) { }
    }

    @Test fun crashInsideModelRegistrationIsResolvedOnRestart() = runBlocking {
        val store = open()
        val p = store.createProject("p")
        val s = store.createSession(p.id, CaptureSource.IMPORT, DeviceInfo())
        val (_, modelA) = store.completedModel(p.id, s.id)
        val projectBefore = File(root, "${p.id}/project.json").readText()

        // Job B: model directory complete, process dies before project.json is rewritten.
        val (jobB, modelB) = store.completedModel(p.id, s.id, randomBytes(3000, 11))
        File(root, "${p.id}/project.json").writeText(projectBefore.replace("\"jobIds\":[", "\"jobIds\":[\"${jobB.id}\","))
        val jobJson = File(store.jobDir(p.id, jobB.id), "job.json")
        jobJson.writeText(jobJson.readText().replace("\"phase\":\"COMPLETED\"", "\"phase\":\"DOWNLOADING\"").replace("\"modelId\":\"$modelB\",", ""))
        // Job C: same crash point, but the job was cancelled → its unreferenced model must not appear.
        val jobC = store.createJob(p.id, s.id, "preview", listOf("a"), 1, "srv", "PC")
        store.updateJob(p.id, jobC.id, JobEvent.CancelRequested)
        val strayId = Ids.newUuid()
        val stray = File(root, "${p.id}/models/$strayId").apply { mkdirs() }
        File(stray, "model.glb").writeBytes(randomBytes(100, 1))
        File(stray, "model.json").writeText(File(store.modelDir(p.id, modelB), "model.json").readText()
            .replace(modelB, strayId).replace(jobB.id, jobC.id))
        // and a half-built staging directory
        File(root, "${p.id}/models/.staging-${Ids.newUuid()}").mkdirs()

        val re = open()
        assertEquals(JobPhase.DOWNLOADING, Json { ignoreUnknownKeys = true }.decodeFromString(ReconJob.serializer(),
            jobJson.readText().replace("COMPLETED", "DOWNLOADING")).phase)   // sanity: the fixture really was mid-download
        assertEquals(JobPhase.COMPLETED, re.job(p.id, jobB.id)!!.phase)
        assertEquals(modelB, re.job(p.id, jobB.id)!!.modelId)
        assertEquals(modelB, re.project(p.id)!!.activeModelId)
        assertEquals(setOf(modelA, modelB), re.models(p.id).map { it.id }.toSet())
        assertFalse(stray.exists())
        assertEquals(JobPhase.CANCELLED, re.job(p.id, jobC.id)!!.phase)
        assertEquals(setOf(modelA, modelB), File(root, "${p.id}/models").list()!!.toSet())
    }

    @Test fun latestJobDrivesTheLibraryRow() = runBlocking {
        val store = open()
        val p = store.createProject("p")
        val s = store.createSession(p.id, CaptureSource.IMPORT, DeviceInfo())
        store.completedModel(p.id, s.id)
        assertEquals(JobPhase.COMPLETED, store.summaries.value.single().latestJobPhase)
        val job = store.createJob(p.id, s.id, "preview", listOf("a"), 100, "srv", "PC")
        store.updateJob(p.id, job.id, JobEvent.UploadStarted)
        store.updateJob(p.id, job.id, JobEvent.UploadFinishedAndSubmitted)
        store.updateJob(p.id, job.id, JobEvent.RemoteStateChanged("running")) { j, _ -> j.copy(overallProgress = 0.61f) }
        var row = store.summaries.value.single()
        assertEquals(JobPhase.RUNNING, row.latestJobPhase); assertEquals(0.61f, row.latestJobProgress, 1e-6f)
        assertTrue(row.hasModel)                       // the earlier model is still there while the new job runs
        store.updateJob(p.id, job.id, JobEvent.RemoteStateChanged("failed"))
        row = open().summaries.value.single()
        assertEquals(JobPhase.FAILED, row.latestJobPhase); assertTrue(row.hasModel)
    }
}
