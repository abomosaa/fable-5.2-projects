package dev.pocket3d.data

import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.security.MessageDigest
import java.util.UUID

/** Thrown instead of writing when the phone is (nearly) out of storage. Nothing was changed. */
class InsufficientStorageException(val requiredBytes: Long, val freeBytes: Long) : IOException(
    "Not enough free storage: ${requiredBytes / 1_000_000} MB needed plus a 50 MB reserve, " +
        "${freeBytes / 1_000_000} MB free"
)

/** Strict validation of everything that ever becomes part of a path. */
internal object Ids {
    /** Lower-case UUIDv4 — same pattern the companion enforces for session and job ids. */
    val UUID4 = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    /** Frame ids double as the companion's file ids. */
    val FRAME_ID = Regex("^[A-Za-z0-9_-]{1,32}$")
    val FRAME_FILE = Regex("^([A-Za-z0-9_-]{1,32})\\.(jpg|png|webp|heic)$")
    val SHA256 = Regex("^[0-9a-f]{64}$")

    fun newUuid(): String = UUID.randomUUID().toString()

    fun requireUuid(id: String, what: String): String {
        require(UUID4.matches(id)) { "invalid $what id" }
        return id
    }

    fun requireFrameId(id: String): String {
        require(FRAME_ID.matches(id)) { "invalid frame id" }
        return id
    }

    /** File extension for a frame format; the only place a format string turns into a file name. */
    fun extensionFor(format: String): String = when (format) {
        "jpeg" -> "jpg"
        "png" -> "png"
        "webp" -> "webp"
        "heic" -> "heic"
        else -> throw IllegalArgumentException("unsupported photo format")
    }

    fun formatForExtension(ext: String): String = if (ext == "jpg") "jpeg" else ext
}

/** Crash-safe file primitives used by the project store. Pure java.io / java.nio. */
internal object StorageFiles {
    const val TMP_SUFFIX = ".tmp"
    const val BAK_SUFFIX = ".bak"

    fun fsyncDir(dir: File) {
        try {
            FileChannel.open(dir.toPath(), StandardOpenOption.READ).use { it.force(true) }
        } catch (_: IOException) {
            // Not supported on every file system; the rename itself is still atomic.
        } catch (_: UnsupportedOperationException) {
        }
    }

    fun fsyncFile(file: File) {
        try {
            FileChannel.open(file.toPath(), StandardOpenOption.READ).use { it.force(true) }
        } catch (_: IOException) {
        }
    }

    /**
     * Replaces [target] with [bytes]: temp file → fsync → (previous version kept as `.bak`) →
     * atomic rename → directory fsync. A reader therefore sees either the old or the new
     * complete content, never a torn file.
     */
    fun writeAtomic(target: File, bytes: ByteArray, keepBackup: Boolean = true) {
        val dir = target.parentFile ?: throw IOException("no parent directory")
        if (!dir.isDirectory && !dir.mkdirs() && !dir.isDirectory) throw IOException("cannot create ${dir.name}")
        val tmp = File(dir, target.name + "." + java.lang.Long.toHexString(System.nanoTime()) + TMP_SUFFIX)
        try {
            FileOutputStream(tmp).use { out ->
                out.write(bytes)
                out.flush()
                out.fd.sync()
            }
            if (keepBackup && target.isFile) {
                val bak = File(dir, target.name + BAK_SUFFIX)
                try {
                    // Hard link: the current version stays reachable under both names, so there
                    // is no moment without a valid target.
                    Files.deleteIfExists(bak.toPath())
                    Files.createLink(bak.toPath(), target.toPath())
                } catch (_: Exception) {
                    try {
                        Files.copy(target.toPath(), bak.toPath(), StandardCopyOption.REPLACE_EXISTING)
                    } catch (_: IOException) {
                    }
                }
            }
            moveAtomic(tmp, target)
            fsyncDir(dir)
        } finally {
            if (tmp.exists()) tmp.delete()
        }
    }

    fun moveAtomic(from: File, to: File) {
        try {
            Files.move(from.toPath(), to.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
            Files.move(from.toPath(), to.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
    }

    data class Digest(val sha256: String, val size: Long)

    fun sha256(file: File): Digest {
        val md = MessageDigest.getInstance("SHA-256")
        var size = 0L
        FileInputStream(file).use { input ->
            val buf = ByteArray(128 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
                size += n
            }
        }
        return Digest(hex(md.digest()), size)
    }

    fun sha256(bytes: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(bytes))

    fun hex(bytes: ByteArray): String {
        val chars = CharArray(bytes.size * 2)
        val digits = "0123456789abcdef"
        for (i in bytes.indices) {
            val v = bytes[i].toInt() and 0xFF
            chars[i * 2] = digits[v ushr 4]
            chars[i * 2 + 1] = digits[v and 0x0F]
        }
        return String(chars)
    }

    /** Copies [from] to [to] (fsynced), returning the digest of the copied bytes. */
    fun copyFile(from: File, to: File): Digest {
        val md = MessageDigest.getInstance("SHA-256")
        var size = 0L
        FileInputStream(from).use { input ->
            FileOutputStream(to).use { out ->
                val buf = ByteArray(128 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    md.update(buf, 0, n)
                    size += n
                }
                out.flush()
                out.fd.sync()
            }
        }
        return Digest(hex(md.digest()), size)
    }

    fun deleteRecursively(file: File) {
        // Never follow symlinks out of the tree.
        if (Files.isSymbolicLink(file.toPath())) {
            file.delete()
            return
        }
        file.listFiles()?.forEach { deleteRecursively(it) }
        file.delete()
    }

    fun dirSize(file: File): Long {
        if (Files.isSymbolicLink(file.toPath())) return 0
        if (file.isFile) return file.length()
        var total = 0L
        file.listFiles()?.forEach { total += dirSize(it) }
        return total
    }
}
