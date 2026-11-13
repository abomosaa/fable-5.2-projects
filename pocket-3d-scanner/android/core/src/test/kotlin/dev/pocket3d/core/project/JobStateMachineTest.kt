package dev.pocket3d.core.project

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class JobStateMachineTest {
    private fun run(start: JobPhase, vararg events: JobEvent): JobPhase =
        events.fold(start) { p, e -> JobStateMachine.transition(p, e) }

    private val allEvents: List<JobEvent> = listOf(
        JobEvent.UploadStarted, JobEvent.UploadFinishedAndSubmitted, JobEvent.ResultsVerified,
        JobEvent.TransferFailed(false), JobEvent.TransferFailed(true), JobEvent.CancelRequested,
        JobEvent.RetryRequested, JobEvent.RemoteJobMissing,
    ) + listOf("queued", "running", "cancelling", "succeeded", "failed", "cancelled", "interrupted", "garbage")
        .map { JobEvent.RemoteStateChanged(it) }

    @Test fun happyPath() {
        assertEquals(JobPhase.COMPLETED, run(JobPhase.PENDING, JobEvent.UploadStarted, JobEvent.UploadFinishedAndSubmitted,
            JobEvent.RemoteStateChanged("queued"), JobEvent.RemoteStateChanged("running"),
            JobEvent.RemoteStateChanged("succeeded"), JobEvent.ResultsVerified))
    }

    @Test fun remoteSuccessAloneIsNotCompletion() {
        // The companion saying "succeeded" only starts the download; the job is complete only
        // after the artifacts are on the phone and verified.
        val p = run(JobPhase.RUNNING, JobEvent.RemoteStateChanged("succeeded"))
        assertEquals(JobPhase.DOWNLOADING, p)
        assertFalse(p.isTerminal)
        // a permanent download failure after remote success is a failure, never a completion
        assertEquals(JobPhase.FAILED, run(p, JobEvent.TransferFailed(permanent = true)))
    }

    @Test fun completedIsReachableOnlyThroughVerifiedDownload() {
        for (start in JobPhase.entries) for (e in allEvents) {
            val next = JobStateMachine.transition(start, e)
            if (next == JobPhase.COMPLETED && start != JobPhase.COMPLETED) {
                assertEquals("only DOWNLOADING may complete", JobPhase.DOWNLOADING, start)
                assertEquals(JobEvent.ResultsVerified, e)
            }
        }
    }

    @Test fun terminalPhasesAreLeftOnlyByExplicitRetry() {
        for (start in JobPhase.entries.filter { it.isTerminal }) for (e in allEvents) {
            val next = JobStateMachine.transition(start, e)
            if (next != start) {
                assertEquals(JobEvent.RetryRequested, e)
                assertEquals(JobPhase.PENDING, next)
                assertTrue(start.canRetry)
            }
        }
        // a completed job cannot be "retried" into overwriting itself
        assertEquals(JobPhase.COMPLETED, run(JobPhase.COMPLETED, JobEvent.RetryRequested))
    }

    @Test fun distinguishesCancelFailInterrupt() {
        assertEquals(JobPhase.CANCELLED, run(JobPhase.RUNNING, JobEvent.RemoteStateChanged("cancelled")))
        assertEquals(JobPhase.FAILED, run(JobPhase.RUNNING, JobEvent.RemoteStateChanged("failed")))
        assertEquals(JobPhase.INTERRUPTED, run(JobPhase.RUNNING, JobEvent.RemoteStateChanged("interrupted")))
        assertEquals(JobPhase.INTERRUPTED, run(JobPhase.QUEUED, JobEvent.RemoteJobMissing))
        assertEquals(JobPhase.INTERRUPTED, run(JobPhase.DOWNLOADING, JobEvent.RemoteJobMissing))
        // …but a job that was never submitted is not "interrupted" by a missing remote job
        assertEquals(JobPhase.UPLOADING, run(JobPhase.UPLOADING, JobEvent.RemoteJobMissing))
    }

    @Test fun cancellationWinsOverLateProgress() {
        val p = run(JobPhase.RUNNING, JobEvent.CancelRequested, JobEvent.RemoteStateChanged("running"),
                    JobEvent.RemoteStateChanged("succeeded"), JobEvent.ResultsVerified)
        assertEquals(JobPhase.CANCELLED, p)
    }

    @Test fun transientFailuresNeverFailAJob() {
        for (start in JobPhase.entries.filter { it.isActive })
            assertEquals(start, JobStateMachine.transition(start, JobEvent.TransferFailed(permanent = false)))
    }

    @Test fun eventsAreIdempotentAfterRestartReplay() {
        // Replaying the last event after a process restart must not change the outcome.
        for (start in JobPhase.entries) for (e in allEvents) {
            val once = JobStateMachine.transition(start, e)
            if (e == JobEvent.RetryRequested) continue      // retry intentionally restarts
            assertEquals("$start + $e twice", once, JobStateMachine.transition(once, e))
        }
    }

    @Test fun downloadIsNotRegressedByStaleRemoteStates() {
        assertEquals(JobPhase.DOWNLOADING, run(JobPhase.DOWNLOADING, JobEvent.RemoteStateChanged("running")))
        assertEquals(JobPhase.DOWNLOADING, run(JobPhase.DOWNLOADING, JobEvent.RemoteStateChanged("queued")))
    }

    @Test fun unknownRemoteStateIsIgnored() {
        assertEquals(JobPhase.RUNNING, run(JobPhase.RUNNING, JobEvent.RemoteStateChanged("something-new")))
    }

    @Test fun retryFromEveryRetryablePhaseRestartsCleanly() {
        for (start in listOf(JobPhase.FAILED, JobPhase.CANCELLED, JobPhase.INTERRUPTED)) {
            assertEquals(JobPhase.COMPLETED, run(start, JobEvent.RetryRequested, JobEvent.UploadStarted,
                JobEvent.UploadFinishedAndSubmitted, JobEvent.RemoteStateChanged("running"),
                JobEvent.RemoteStateChanged("succeeded"), JobEvent.ResultsVerified))
        }
    }
}
