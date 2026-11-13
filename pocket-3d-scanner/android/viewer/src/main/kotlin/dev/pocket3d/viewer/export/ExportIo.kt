package dev.pocket3d.viewer.export

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException

/** Own provider class so the manifest entry cannot clash with another FileProvider in the app. */
class ViewerFileProvider : FileProvider()

/** A write or read-back failure with a message for the user. */
class ExportIoException(message: String, cause: Throwable? = null) : IOException(message, cause)

/** Writing exports to their destination and reading them back for the self-check. */
object ExportIo {
    const val EXPORT_DIR = "exports"

    fun authority(context: Context): String = "${context.packageName}.viewer.files"

    private fun describe(e: Throwable): String {
        val m = e.message ?: e.javaClass.simpleName
        return if (m.contains("ENOSPC") || m.contains("No space", ignoreCase = true)) "There is not enough free storage space." else m
    }

    /** Streams [bytes] to a document chosen with the system file picker, then reads it back. */
    fun writeToDocument(context: Context, uri: Uri, bytes: ByteArray): ByteArray {
        val resolver = context.contentResolver
        try {
            val out = resolver.openOutputStream(uri, "wt")
                ?: throw ExportIoException("The chosen location could not be opened for writing.")
            out.use { stream ->
                var off = 0
                while (off < bytes.size) {
                    val n = minOf(1 shl 16, bytes.size - off)
                    stream.write(bytes, off, n)
                    off += n
                }
                stream.flush()
            }
        } catch (e: ExportIoException) {
            throw e
        } catch (e: FileNotFoundException) {
            throw ExportIoException("The chosen location is not available any more.", e)
        } catch (e: IOException) {
            throw ExportIoException("Writing failed: ${describe(e)}", e)
        } catch (e: SecurityException) {
            throw ExportIoException("The app is not allowed to write to the chosen location.", e)
        } catch (e: RuntimeException) {
            // document providers report their own failures as unchecked exceptions
            throw ExportIoException("The storage provider reported an error: ${describe(e)}", e)
        }
        try {
            val input = resolver.openInputStream(uri) ?: throw ExportIoException("The saved file could not be opened to verify it.")
            return input.use { it.readBytes() }
        } catch (e: ExportIoException) {
            throw e
        } catch (e: IOException) {
            throw ExportIoException("The saved file could not be read back to verify it: ${describe(e)}", e)
        } catch (e: RuntimeException) {
            throw ExportIoException("The saved file could not be read back to verify it: ${describe(e)}", e)
        }
    }

    /** Best effort: remove a document that turned out to be incomplete or wrong. */
    fun deleteDocument(context: Context, uri: Uri) {
        try { DocumentsContract.deleteDocument(context.contentResolver, uri) } catch (e: Exception) { /* nothing more we can do */ }
    }

    /** Writes into `cacheDir/exports/` for sharing and reads the file back. Old exports are removed first. */
    fun writeToShareCache(context: Context, fileName: String, bytes: ByteArray): Pair<File, ByteArray> {
        val dir = File(context.cacheDir, EXPORT_DIR)
        try {
            if (!dir.isDirectory && !dir.mkdirs()) throw ExportIoException("The export folder could not be created.")
            dir.listFiles()?.forEach { runCatching { it.delete() } }
            val file = File(dir, fileName)
            file.outputStream().use { it.write(bytes); it.flush(); it.fd.sync() }
            return file to file.readBytes()
        } catch (e: ExportIoException) {
            throw e
        } catch (e: IOException) {
            throw ExportIoException("Writing the file to share failed: ${describe(e)}", e)
        }
    }

    fun shareUri(context: Context, file: File): Uri = FileProvider.getUriForFile(context, authority(context), file)

    fun shareIntent(uri: Uri, mimeType: String, title: String): Intent {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = mimeType
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_SUBJECT, title)
            clipData = android.content.ClipData.newRawUri(title, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        return Intent.createChooser(send, "Share $title").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
}
