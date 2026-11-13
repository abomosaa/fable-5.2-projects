package dev.pocket3d.core.project

import kotlinx.serialization.Serializable

/**
 * Phone-side lifecycle of a reconstruction job. The phone only ever captures, uploads, shows
 * progress and downloads; the reconstruction itself runs on the companion computer.
 */
@Serializable
enum class JobPhase {
    /** Created locally, nothing sent yet. */
    PENDING,
    /** Photos are being uploaded to the companion (resumable). */
    UPLOADING,
    /** Accepted by the companion, waiting for a free slot. */
    QUEUED,
    /** The companion is reconstructing. */
    RUNNING,
    /** Reconstruction finished on the companion; results are being downloaded and verified. */
    DOWNLOADING,
    /** Results downloaded, verified and stored as a model version. */
    COMPLETED,
    /** Reconstruction or transfer failed with a diagnosed error. */
    FAILED,
    /** Cancelled by the user. */
    CANCELLED,
    /** The companion stopped/restarted mid-job. Nothing is complete; the job can be retried. */
    INTERRUPTED;

    val isTerminal: Boolean get() = this == COMPLETED || this == FAILED || this == CANCELLED || this == INTERRUPTED
    val isActive: Boolean get() = !isTerminal
    val canRetry: Boolean get() = this == FAILED || this == CANCELLED || this == INTERRUPTED
    val canCancel: Boolean get() = isActive
}

/** Everything that can happen to a job. Pure data so transitions are unit-testable. */
sealed interface JobEvent {
    data object UploadStarted : JobEvent
    data object UploadFinishedAndSubmitted : JobEvent
    data class RemoteStateChanged(val remoteState: String) : JobEvent
    /** All artifacts downloaded and their size + SHA-256 verified. */
    data object ResultsVerified : JobEvent
    data class TransferFailed(val permanent: Boolean) : JobEvent
    data object CancelRequested : JobEvent
    data object RetryRequested : JobEvent
    /** The companion no longer knows this job (e.g. its data directory was wiped). */
    data object RemoteJobMissing : JobEvent
}

object JobStateMachine {
    /**
     * Next phase for [phase] on [event]; returns [phase] unchanged for events that do not apply
     * (transitions are idempotent, so replaying an event after a process restart is harmless).
     *
     * Invariants enforced here:
     *  * COMPLETED is reachable only through DOWNLOADING + [JobEvent.ResultsVerified] — a remote
     *    "succeeded" is not enough until the artifacts are on the phone and verified.
     *  * A terminal phase is left only by an explicit [JobEvent.RetryRequested].
     *  * Cancellation wins over late progress reports.
     */
    fun transition(phase: JobPhase, event: JobEvent): JobPhase = when (event) {
        JobEvent.UploadStarted -> if (phase == JobPhase.PENDING) JobPhase.UPLOADING else phase
        JobEvent.UploadFinishedAndSubmitted ->
            if (phase == JobPhase.PENDING || phase == JobPhase.UPLOADING) JobPhase.QUEUED else phase
        is JobEvent.RemoteStateChanged -> when {
            phase.isTerminal || phase == JobPhase.PENDING || phase == JobPhase.UPLOADING -> phase
            else -> when (event.remoteState) {
                "queued" -> if (phase == JobPhase.DOWNLOADING) phase else JobPhase.QUEUED
                "running" -> if (phase == JobPhase.DOWNLOADING) phase else JobPhase.RUNNING
                "cancelling" -> phase
                "succeeded" -> JobPhase.DOWNLOADING
                "failed" -> JobPhase.FAILED
                "cancelled" -> JobPhase.CANCELLED
                "interrupted" -> JobPhase.INTERRUPTED
                else -> phase
            }
        }
        JobEvent.ResultsVerified -> if (phase == JobPhase.DOWNLOADING) JobPhase.COMPLETED else phase
        is JobEvent.TransferFailed -> when {
            phase.isTerminal -> phase
            event.permanent -> JobPhase.FAILED
            else -> phase   // transient: stay, the sync engine retries with back-off
        }
        JobEvent.CancelRequested -> if (phase.isTerminal) phase else JobPhase.CANCELLED
        JobEvent.RetryRequested -> if (phase.canRetry) JobPhase.PENDING else phase
        JobEvent.RemoteJobMissing -> when (phase) {
            JobPhase.QUEUED, JobPhase.RUNNING, JobPhase.DOWNLOADING -> JobPhase.INTERRUPTED
            else -> phase
        }
    }
}
