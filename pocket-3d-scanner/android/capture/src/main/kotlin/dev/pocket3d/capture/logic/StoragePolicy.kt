package dev.pocket3d.capture.logic

enum class StorageLevel { OK, LOW, BLOCKED }

/** Free-space thresholds for capturing photos. */
object StoragePolicy {
    /** Below this a warning is shown. */
    const val WARN_BYTES = 500L * 1024 * 1024
    /** Below this capture is blocked: a failed write in the middle of a session is worse than stopping early. */
    const val BLOCK_BYTES = 150L * 1024 * 1024

    fun level(freeBytes: Long): StorageLevel = when {
        freeBytes < BLOCK_BYTES -> StorageLevel.BLOCKED
        freeBytes < WARN_BYTES -> StorageLevel.LOW
        else -> StorageLevel.OK
    }
}
