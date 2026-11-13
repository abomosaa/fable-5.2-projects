//! Transcription job runner.
//!
//! Drives one asset through the provider's asynchronous flow and records every step
//! honestly in a persisted [`TranscriptionStatus`]:
//!
//! ```text
//! Queued ──► Uploading ──► Processing ──► Completed
//!    │           │             │
//!    └───────────┴─────────────┴──► Failed (retryable or not) / Cancelled
//! ```
//!
//! Remote ids are persisted the moment they are known, so a server restart can
//! resume a running transcription or at least delete what was left behind. Whatever
//! the outcome, the uploaded file and the remote transcription are deleted
//! afterwards; a failed deletion is recorded (`CleanupState::Failed`) and retried by
//! [`TranscriptionManager::resume_pending`] / [`TranscriptionManager::purge`].

use crate::soniox::SpeechApi;
use cutline_core::soniox::{
    can_start, remote_status, tokens_to_transcript, transcription_failed, CleanupState, JobState,
    ProviderError, ProviderErrorKind, RemoteStatus, SonioxTranscription, TranscriptionStatus,
};
use cutline_core::transcript::Transcript;
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{watch, Notify, Semaphore};
use tokio_util::sync::CancellationToken;

/// Persistence + notification seam, implemented by the asset store.
///
/// Implementations must not call back into the [`TranscriptionManager`] from these
/// methods (they are invoked while internal locks may be held).
pub trait TranscriptionStore: Send + Sync + 'static {
    /// Extracted audio to upload for the asset, and its duration in ms.
    fn audio_for_upload(&self, asset_id: &str) -> Result<(PathBuf, i64), String>;
    fn load_status(&self, asset_id: &str) -> Option<TranscriptionStatus>;
    /// Must persist the status and notify listeners.
    fn save_status(&self, asset_id: &str, status: &TranscriptionStatus);
    fn save_transcript(&self, asset_id: &str, transcript: &Transcript) -> Result<(), String>;
    fn all_statuses(&self) -> Vec<(String, TranscriptionStatus)>;
}

#[derive(Clone, Debug)]
pub struct TranscriptionOptions {
    /// Delay between status polls while the provider is working.
    pub poll_interval: Duration,
    /// Give up (retryable failure) when the provider has not finished after this long.
    pub max_wait: Duration,
    /// Attempts per API call for transient errors (1 == no automatic retry).
    pub max_attempts: u32,
    /// Base delay between attempts; doubles each time (capped at one minute).
    pub retry_backoff: Duration,
}

impl Default for TranscriptionOptions {
    fn default() -> Self {
        TranscriptionOptions {
            poll_interval: Duration::from_secs(2),
            max_wait: Duration::from_secs(2 * 60 * 60),
            max_attempts: 4,
            retry_backoff: Duration::from_secs(2),
        }
    }
}

/// Jobs talking to the provider at the same time; the rest wait as `Queued`.
pub const MAX_CONCURRENT_JOBS: usize = 3;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

struct Job {
    generation: u64,
    cancel: CancellationToken,
    done: watch::Receiver<bool>,
}

struct Inner {
    api: Arc<dyn SpeechApi>,
    store: Arc<dyn TranscriptionStore>,
    opts: TranscriptionOptions,
    jobs: Mutex<HashMap<String, Job>>,
    permits: Arc<Semaphore>,
    idle: Notify,
    next_generation: AtomicU64,
}

impl Inner {
    fn provider_name(&self) -> &'static str {
        if self.api.is_fixture() {
            "the fixture provider"
        } else {
            "Soniox"
        }
    }

    fn backoff(&self, attempt: u32) -> Duration {
        let factor = 1u32 << attempt.saturating_sub(1).min(6);
        self.opts
            .retry_backoff
            .saturating_mul(factor)
            .min(Duration::from_secs(60))
    }

    /// Delete one remote object, retrying transient failures. Not cancellable:
    /// cleanup must run to completion. Returns true when the object is gone.
    async fn delete_one(&self, id: &str, is_file: bool) -> bool {
        let attempts = self.opts.max_attempts.max(1);
        for attempt in 1..=attempts {
            let r = if is_file {
                self.api.delete_file(id).await
            } else {
                self.api.delete_transcription(id).await
            };
            match r {
                Ok(()) => return true,
                Err(e) if e.kind == ProviderErrorKind::NotFound => return true,
                Err(e) if e.retryable && attempt < attempts => {
                    tokio::time::sleep(self.backoff(attempt)).await;
                }
                Err(e) => {
                    tracing::warn!(remote_id = id, kind = ?e.kind, "could not delete remote {}: {}", if is_file { "file" } else { "transcription" }, e.message);
                    return false;
                }
            }
        }
        false
    }

    /// Delete the remote transcription, then the uploaded file. Returns the ids that
    /// are still alive.
    async fn delete_remote(
        &self,
        file_id: Option<String>,
        transcription_id: Option<String>,
    ) -> (Option<String>, Option<String>) {
        let mut tx_left = None;
        if let Some(id) = transcription_id {
            if !self.delete_one(&id, false).await {
                tx_left = Some(id);
            }
        }
        let mut file_left = None;
        if let Some(id) = file_id {
            if !self.delete_one(&id, true).await {
                file_left = Some(id);
            }
        }
        (file_left, tx_left)
    }

    /// Run remote cleanup for a finished status and persist the outcome.
    async fn cleanup_status(&self, asset_id: &str, st: &mut TranscriptionStatus) {
        if !st.has_remote_objects() {
            if st.cleanup == CleanupState::Pending {
                st.record_cleanup(None, None, false, now_ms());
                self.store.save_status(asset_id, st);
            }
            return;
        }
        let (file_left, tx_left) = self
            .delete_remote(st.file_id.clone(), st.transcription_id.clone())
            .await;
        st.record_cleanup(file_left, tx_left, true, now_ms());
        self.store.save_status(asset_id, st);
    }
}

enum Mode {
    /// Upload and transcribe from scratch, first deleting leftovers of an earlier run.
    Fresh {
        stale_file: Option<String>,
        stale_transcription: Option<String>,
    },
    /// Continue polling a transcription created before a restart.
    Resume { transcription_id: String },
}

/// Removes the job from the registry and wakes waiters even if the task panics.
struct Finish {
    inner: Arc<Inner>,
    asset_id: String,
    generation: u64,
    done: watch::Sender<bool>,
}

impl Drop for Finish {
    fn drop(&mut self) {
        if let Ok(mut jobs) = self.inner.jobs.lock() {
            if jobs.get(&self.asset_id).map(|j| j.generation) == Some(self.generation) {
                jobs.remove(&self.asset_id);
            }
        }
        let _ = self.done.send(true);
        self.inner.idle.notify_waiters();
    }
}

struct Run {
    inner: Arc<Inner>,
    asset_id: String,
    st: TranscriptionStatus,
    cancel: CancellationToken,
}

impl Run {
    fn save(&mut self) {
        self.st.updated_at_ms = now_ms();
        self.inner.store.save_status(&self.asset_id, &self.st);
    }

    fn note(&mut self, message: String) {
        if self.st.message.as_deref() != Some(message.as_str()) {
            self.st.message = Some(message);
            self.save();
        }
    }

    fn enter(&mut self, state: JobState, message: Option<String>) {
        self.st.state = state;
        self.st.message = message;
        self.st.error_kind = None;
        self.st.retryable = false;
        self.save();
    }

    async fn sleep(&self, d: Duration) -> Result<(), ProviderError> {
        tokio::select! {
            biased;
            _ = self.cancel.cancelled() => Err(ProviderError::cancelled()),
            _ = tokio::time::sleep(d) => Ok(()),
        }
    }

    /// One provider call: cancellable, with automatic retry of transient errors.
    async fn call<T, F, Fut>(&mut self, mut f: F) -> Result<T, ProviderError>
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = Result<T, ProviderError>>,
    {
        let max = self.inner.opts.max_attempts.max(1);
        let mut attempt = 1;
        loop {
            let r = tokio::select! {
                biased;
                _ = self.cancel.cancelled() => return Err(ProviderError::cancelled()),
                r = f() => r,
            };
            match r {
                Ok(v) => return Ok(v),
                Err(e) if e.retryable && attempt < max => {
                    self.st.attempts += 1;
                    self.note(format!(
                        "{} Retrying automatically (attempt {} of {max})…",
                        e.message,
                        attempt + 1
                    ));
                    self.sleep(self.inner.backoff(attempt)).await?;
                    attempt += 1;
                }
                Err(e) => return Err(e),
            }
        }
    }

    async fn execute(mut self, mode: Mode) {
        if let Err(e) = self.pipeline(mode).await {
            if e.is_cancelled() {
                tracing::info!(asset_id = %self.asset_id, "transcription cancelled");
            } else {
                tracing::warn!(asset_id = %self.asset_id, kind = ?e.kind, retryable = e.retryable, "transcription failed: {}", e.message);
            }
            self.st.fail(&e, now_ms());
            self.save();
        }
        // Completed, failed or cancelled: the remote objects are no longer needed.
        let inner = self.inner.clone();
        inner.cleanup_status(&self.asset_id, &mut self.st).await;
    }

    async fn pipeline(&mut self, mode: Mode) -> Result<(), ProviderError> {
        let api = self.inner.api.clone();
        // Wait for a worker slot; until then the job is honestly "queued".
        let permits = self.inner.permits.clone();
        let _permit = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return Err(ProviderError::cancelled()),
            p = permits.acquire_owned() => p.map_err(|_| ProviderError::io("The transcription service is shutting down."))?,
        };

        let mut mode = mode;
        if let Mode::Resume { transcription_id } = &mode {
            let id = transcription_id.clone();
            self.enter(
                JobState::Processing,
                Some(format!("Reconnecting to {}…", self.inner.provider_name())),
            );
            match self.call(|| api.get_transcription(&id)).await {
                Ok(tx) => return self.finish_remote(tx, id).await,
                Err(e) if e.kind == ProviderErrorKind::NotFound => {
                    // The remote job is gone (expired or provider restarted): start over.
                    self.st.transcription_id = None;
                    mode = Mode::Fresh {
                        stale_file: self.st.file_id.take(),
                        stale_transcription: None,
                    };
                }
                Err(e) => return Err(e),
            }
        }
        let Mode::Fresh {
            stale_file,
            stale_transcription,
        } = mode
        else {
            unreachable!()
        };
        if stale_file.is_some() || stale_transcription.is_some() {
            let (f, t) = self
                .inner
                .delete_remote(stale_file, stale_transcription)
                .await;
            if f.is_some() || t.is_some() {
                tracing::warn!(asset_id = %self.asset_id, "leftover remote objects from an earlier run could not be deleted");
            }
        }
        if self.cancel.is_cancelled() {
            return Err(ProviderError::cancelled());
        }

        // ---- upload ------------------------------------------------------------
        self.enter(
            JobState::Uploading,
            Some(format!(
                "Uploading audio to {}…",
                self.inner.provider_name()
            )),
        );
        let (path, duration_ms) = self
            .inner
            .store
            .audio_for_upload(&self.asset_id)
            .map_err(|e| ProviderError::io(&e))?;
        self.st.audio_duration_ms = Some(duration_ms);
        let filename = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "audio".to_string());
        let file_id = self
            .call(|| api.upload_file(&path, &filename, duration_ms))
            .await?;
        self.st.file_id = Some(file_id.clone());
        self.st.cleanup = CleanupState::Pending;

        // ---- create ------------------------------------------------------------
        self.enter(
            JobState::Processing,
            Some("Starting transcription…".to_string()),
        );
        let asset_id = self.asset_id.clone();
        let tx = self
            .call(|| api.create_transcription(&file_id, &asset_id))
            .await?;
        if tx.id.trim().is_empty() {
            return Err(ProviderError::invalid_response(
                "the transcription was created without an id",
            ));
        }
        let id = tx.id.clone();
        self.st.transcription_id = Some(id.clone());
        self.save();
        self.finish_remote(tx, id).await
    }

    /// Poll until the provider finishes, then fetch, normalise and store the transcript.
    async fn finish_remote(
        &mut self,
        first: SonioxTranscription,
        id: String,
    ) -> Result<(), ProviderError> {
        let api = self.inner.api.clone();
        let started = Instant::now();
        let mut tx = first;
        loop {
            if let Some(d) = tx.audio_duration_ms.filter(|d| *d > 0) {
                self.st.audio_duration_ms = Some(d);
            }
            match remote_status(&tx) {
                RemoteStatus::Completed => break,
                RemoteStatus::Error {
                    error_type,
                    message,
                } => return Err(transcription_failed(error_type.as_deref(), &message)),
                RemoteStatus::Queued => self.note(format!(
                    "Waiting in the queue at {}…",
                    self.inner.provider_name()
                )),
                RemoteStatus::Processing => self.note("Transcribing…".to_string()),
            }
            if started.elapsed() >= self.inner.opts.max_wait {
                return Err(ProviderError::timeout(
                    "waiting for the transcription to finish",
                ));
            }
            self.sleep(self.inner.opts.poll_interval).await?;
            tx = self.call(|| api.get_transcription(&id)).await?;
        }
        self.note("Downloading transcript…".to_string());
        let remote = self.call(|| api.get_transcript(&id)).await?;
        let transcript = tokens_to_transcript(
            &self.asset_id,
            api.provider(),
            &api.model(),
            api.is_fixture(),
            &remote.tokens,
        );
        self.inner
            .store
            .save_transcript(&self.asset_id, &transcript)
            .map_err(|e| {
                ProviderError::new(
                    ProviderErrorKind::Io,
                    format!("The transcript was received but could not be saved: {e}"),
                    true,
                )
            })?;
        self.st.complete(transcript.words.len() as u32, now_ms());
        self.save();
        tracing::info!(asset_id = %self.asset_id, words = transcript.words.len(), provider = api.provider(), "transcription completed");
        Ok(())
    }
}

/// Owns the transcription jobs. Cheap to clone.
#[derive(Clone)]
pub struct TranscriptionManager {
    inner: Arc<Inner>,
}

impl TranscriptionManager {
    pub fn new(
        api: Arc<dyn SpeechApi>,
        store: Arc<dyn TranscriptionStore>,
        opts: TranscriptionOptions,
    ) -> Self {
        TranscriptionManager {
            inner: Arc::new(Inner {
                api,
                store,
                opts,
                jobs: Mutex::new(HashMap::new()),
                permits: Arc::new(Semaphore::new(MAX_CONCURRENT_JOBS)),
                idle: Notify::new(),
                next_generation: AtomicU64::new(1),
            }),
        }
    }

    pub fn api(&self) -> &Arc<dyn SpeechApi> {
        &self.inner.api
    }

    pub fn status(&self, asset_id: &str) -> Option<TranscriptionStatus> {
        self.inner.store.load_status(asset_id)
    }

    /// Is a job task for this asset alive (including its remote cleanup phase)?
    pub fn is_running(&self, asset_id: &str) -> bool {
        self.inner.jobs.lock().unwrap().contains_key(asset_id)
    }

    fn fresh_status(&self, created_at_ms: Option<i64>) -> TranscriptionStatus {
        let now = now_ms();
        let mut st = TranscriptionStatus::queued(
            self.inner.api.provider(),
            &self.inner.api.model(),
            self.inner.api.is_fixture(),
            now,
        );
        if let Some(c) = created_at_ms {
            st.created_at_ms = c;
        }
        st
    }

    /// Register and spawn a job. The caller holds the `jobs` lock and has already
    /// saved `status`.
    fn spawn_locked(
        &self,
        jobs: &mut HashMap<String, Job>,
        asset_id: &str,
        status: TranscriptionStatus,
        mode: Mode,
    ) {
        let generation = self.inner.next_generation.fetch_add(1, Ordering::Relaxed);
        let cancel = CancellationToken::new();
        let (done_tx, done_rx) = watch::channel(false);
        jobs.insert(
            asset_id.to_string(),
            Job {
                generation,
                cancel: cancel.clone(),
                done: done_rx,
            },
        );
        let finish = Finish {
            inner: self.inner.clone(),
            asset_id: asset_id.to_string(),
            generation,
            done: done_tx,
        };
        let run = Run {
            inner: self.inner.clone(),
            asset_id: asset_id.to_string(),
            st: status,
            cancel,
        };
        tokio::spawn(async move {
            let _finish = finish;
            run.execute(mode).await;
        });
    }

    /// Queue a transcription job for an asset. A no-op returning the current status
    /// when a job is already active, or when a transcript already exists and `force`
    /// is false. Must be called from within a Tokio runtime.
    ///
    /// Errors (nothing is queued) when the asset has no audio ready to upload.
    pub fn start(&self, asset_id: &str, force: bool) -> Result<TranscriptionStatus, ProviderError> {
        let mut jobs = self.inner.jobs.lock().unwrap();
        let current = self.inner.store.load_status(asset_id);
        if jobs.contains_key(asset_id) {
            return Ok(current.unwrap_or_else(|| self.fresh_status(None)));
        }
        // A persisted "active" status without a task is an orphan of a previous
        // process; it may be restarted like a failed one.
        let orphan = current.as_ref().is_some_and(|s| s.is_active());
        if !orphan && !can_start(&current, force) {
            return Ok(current.expect("can_start is true for None"));
        }
        self.inner
            .store
            .audio_for_upload(asset_id)
            .map_err(|e| ProviderError::io(&e))?;
        let same_provider = current
            .as_ref()
            .is_some_and(|s| s.provider == self.inner.api.provider());
        let (stale_file, stale_transcription) = match (&current, same_provider) {
            (Some(s), true) => (s.file_id.clone(), s.transcription_id.clone()),
            _ => (None, None),
        };
        let st = self.fresh_status(None);
        self.inner.store.save_status(asset_id, &st);
        self.spawn_locked(
            &mut jobs,
            asset_id,
            st.clone(),
            Mode::Fresh {
                stale_file,
                stale_transcription,
            },
        );
        Ok(st)
    }

    /// Cancel the asset's job (if any) and wait until it has stopped and cleaned up
    /// remotely. Returns the resulting status.
    pub async fn cancel(&self, asset_id: &str) -> Option<TranscriptionStatus> {
        let job = self
            .inner
            .jobs
            .lock()
            .unwrap()
            .get(asset_id)
            .map(|j| (j.cancel.clone(), j.done.clone()));
        if let Some((token, mut done)) = job {
            token.cancel();
            let _ = done.wait_for(|d| *d).await;
            return self.inner.store.load_status(asset_id);
        }
        let mut st = self.inner.store.load_status(asset_id)?;
        if st.is_active() {
            // orphaned status from a previous process
            st.cancel(now_ms());
            self.inner.store.save_status(asset_id, &st);
            self.inner.cleanup_status(asset_id, &mut st).await;
        }
        Some(st)
    }

    /// Stop any running job and delete every remote object still known for the
    /// asset. Call before deleting an asset or project.
    pub async fn purge(&self, asset_id: &str) {
        self.cancel(asset_id).await;
        if let Some(mut st) = self.inner.store.load_status(asset_id) {
            if st.has_remote_objects() {
                self.inner.cleanup_status(asset_id, &mut st).await;
            }
        }
    }

    /// Startup recovery: continue transcriptions that were processing remotely,
    /// restart jobs that had not got that far, and retry outstanding remote cleanups.
    pub async fn resume_pending(&self) {
        let provider = self.inner.api.provider();
        for (asset_id, st) in self.inner.store.all_statuses() {
            if st.is_active() {
                let mut jobs = self.inner.jobs.lock().unwrap();
                if jobs.contains_key(&asset_id) {
                    continue;
                }
                let same_provider = st.provider == provider;
                match (&st.state, &st.transcription_id, same_provider) {
                    (JobState::Processing, Some(id), true) => {
                        let id = id.clone();
                        tracing::info!(asset_id = %asset_id, "resuming transcription after restart");
                        self.spawn_locked(
                            &mut jobs,
                            &asset_id,
                            st,
                            Mode::Resume {
                                transcription_id: id,
                            },
                        );
                    }
                    _ => {
                        tracing::info!(asset_id = %asset_id, "restarting interrupted transcription");
                        let fresh = self.fresh_status(Some(st.created_at_ms));
                        self.inner.store.save_status(&asset_id, &fresh);
                        let (stale_file, stale_transcription) = if same_provider {
                            (st.file_id, st.transcription_id)
                        } else {
                            (None, None)
                        };
                        self.spawn_locked(
                            &mut jobs,
                            &asset_id,
                            fresh,
                            Mode::Fresh {
                                stale_file,
                                stale_transcription,
                            },
                        );
                    }
                }
            } else if st.has_remote_objects()
                && st.provider == provider
                && !self.is_running(&asset_id)
            {
                let mut st = st;
                self.inner.cleanup_status(&asset_id, &mut st).await;
            }
        }
    }

    /// Resolves when no job task is running (test helper).
    pub async fn wait_idle(&self) {
        loop {
            let notified = self.inner.idle.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.inner.jobs.lock().unwrap().is_empty() {
                return;
            }
            notified.await;
        }
    }
}
