//! Transcription job lifecycle against deterministic adapters: state reporting,
//! retries, cancellation, restart recovery and remote cleanup. No network, no secrets.

use async_trait::async_trait;
use cutline_core::soniox::{
    classify_http_error, CleanupState, JobState, ProviderError, ProviderErrorKind, SonioxToken,
    SonioxTranscript, SonioxTranscription, TranscriptionStatus,
};
use cutline_core::transcript::Transcript;
use cutline_server::soniox::{FixtureSpeech, SonioxHttp, SpeechApi};
use cutline_server::transcription::{
    TranscriptionManager, TranscriptionOptions, TranscriptionStore, MAX_CONCURRENT_JOBS,
};
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Semaphore;

// ---------------------------------------------------------------------------------
// scripted provider
// ---------------------------------------------------------------------------------

type Scripted<T> = Mutex<VecDeque<Result<T, ProviderError>>>;

struct FakeApi {
    upload: Scripted<()>,
    create: Scripted<()>,
    /// Scripted `get_transcription` answers: `Ok(status)` or an error.
    status: Scripted<&'static str>,
    transcript: Scripted<Vec<SonioxToken>>,
    delete_transcription: Scripted<()>,
    delete_file: Scripted<()>,
    /// Status reported once the script is exhausted.
    default_status: Mutex<&'static str>,
    /// When set, a failed transcription reports this (error_type, message).
    remote_error: Mutex<Option<(&'static str, &'static str)>>,
    /// Uploads wait for a permit here (tests use it to hold jobs in "uploading").
    upload_gate: Semaphore,
    files: Mutex<BTreeSet<String>>,
    transcriptions: Mutex<BTreeSet<String>>,
    calls: Mutex<Vec<String>>,
    counter: AtomicU64,
}

impl FakeApi {
    fn new() -> Arc<FakeApi> {
        Arc::new(FakeApi {
            upload: Default::default(),
            create: Default::default(),
            status: Default::default(),
            transcript: Default::default(),
            delete_transcription: Default::default(),
            delete_file: Default::default(),
            default_status: Mutex::new("completed"),
            remote_error: Mutex::new(None),
            upload_gate: Semaphore::new(Semaphore::MAX_PERMITS),
            files: Default::default(),
            transcriptions: Default::default(),
            calls: Default::default(),
            counter: AtomicU64::new(0),
        })
    }

    fn gated() -> Arc<FakeApi> {
        let api = FakeApi::new();
        api.upload_gate.forget_permits(Semaphore::MAX_PERMITS);
        api
    }

    fn log(&self, call: &str) {
        self.calls.lock().unwrap().push(call.to_string());
    }

    fn count(&self, name: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.as_str() == name)
            .count()
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn next<T>(q: &Scripted<T>) -> Option<Result<T, ProviderError>> {
        q.lock().unwrap().pop_front()
    }

    fn live_files(&self) -> Vec<String> {
        self.files.lock().unwrap().iter().cloned().collect()
    }

    fn live_transcriptions(&self) -> Vec<String> {
        self.transcriptions
            .lock()
            .unwrap()
            .iter()
            .cloned()
            .collect()
    }

    fn describe(&self, id: &str, status: &str) -> SonioxTranscription {
        let mut t = SonioxTranscription {
            id: id.to_string(),
            status: status.to_string(),
            model: "fake-model".into(),
            audio_duration_ms: Some(4_000),
            ..Default::default()
        };
        if status == "error" {
            if let Some((ty, msg)) = *self.remote_error.lock().unwrap() {
                t.error_type = Some(ty.to_string());
                t.error_message = Some(msg.to_string());
            }
        }
        t
    }
}

fn http(status: u16) -> ProviderError {
    classify_http_error(status, "")
}

fn sample_tokens() -> Vec<SonioxToken> {
    let tok = |text: &str, s: i64, e: i64| SonioxToken {
        text: text.into(),
        start_ms: Some(s),
        end_ms: Some(e),
        confidence: Some(0.9),
        speaker: Some("1".into()),
        language: Some("en".into()),
        ..Default::default()
    };
    vec![
        tok("Hel", 0, 100),
        tok("lo", 100, 200),
        tok(" wor", 300, 400),
        tok("ld", 400, 500),
        tok(".", 500, 500),
    ]
}

#[async_trait]
impl SpeechApi for FakeApi {
    fn provider(&self) -> &'static str {
        "soniox"
    }
    fn model(&self) -> String {
        "fake-model".into()
    }
    fn is_fixture(&self) -> bool {
        false
    }
    async fn upload_file(
        &self,
        _path: &Path,
        _filename: &str,
        _audio_duration_ms: i64,
    ) -> Result<String, ProviderError> {
        self.log("upload_file");
        let permit = self.upload_gate.acquire().await.unwrap();
        permit.forget();
        if let Some(Err(e)) = Self::next(&self.upload) {
            return Err(e);
        }
        let id = format!("file-{}", self.counter.fetch_add(1, Ordering::SeqCst) + 1);
        self.files.lock().unwrap().insert(id.clone());
        Ok(id)
    }
    async fn create_transcription(
        &self,
        file_id: &str,
        _client_reference_id: &str,
    ) -> Result<SonioxTranscription, ProviderError> {
        self.log("create_transcription");
        if let Some(Err(e)) = Self::next(&self.create) {
            return Err(e);
        }
        assert!(
            self.files.lock().unwrap().contains(file_id),
            "transcription created for a file that does not exist"
        );
        let id = format!("tx-{}", self.counter.fetch_add(1, Ordering::SeqCst) + 1);
        self.transcriptions.lock().unwrap().insert(id.clone());
        Ok(self.describe(&id, "queued"))
    }
    async fn get_transcription(&self, id: &str) -> Result<SonioxTranscription, ProviderError> {
        self.log("get_transcription");
        if !self.transcriptions.lock().unwrap().contains(id) {
            return Err(http(404));
        }
        match Self::next(&self.status) {
            Some(Err(e)) => Err(e),
            Some(Ok(s)) => Ok(self.describe(id, s)),
            None => Ok(self.describe(id, *self.default_status.lock().unwrap())),
        }
    }
    async fn get_transcript(&self, id: &str) -> Result<SonioxTranscript, ProviderError> {
        self.log("get_transcript");
        let tokens = match Self::next(&self.transcript) {
            Some(Err(e)) => return Err(e),
            Some(Ok(t)) => t,
            None => sample_tokens(),
        };
        Ok(SonioxTranscript {
            id: id.to_string(),
            text: String::new(),
            tokens,
        })
    }
    async fn delete_transcription(&self, id: &str) -> Result<(), ProviderError> {
        self.log("delete_transcription");
        if let Some(Err(e)) = Self::next(&self.delete_transcription) {
            return Err(e);
        }
        self.transcriptions.lock().unwrap().remove(id);
        Ok(())
    }
    async fn delete_file(&self, id: &str) -> Result<(), ProviderError> {
        self.log("delete_file");
        if let Some(Err(e)) = Self::next(&self.delete_file) {
            return Err(e);
        }
        self.files.lock().unwrap().remove(id);
        Ok(())
    }
}

// ---------------------------------------------------------------------------------
// in-memory store
// ---------------------------------------------------------------------------------

struct MemStore {
    audio: Option<PathBuf>,
    duration_ms: i64,
    statuses: Mutex<HashMap<String, TranscriptionStatus>>,
    history: Mutex<Vec<(String, TranscriptionStatus)>>,
    transcripts: Mutex<HashMap<String, Transcript>>,
    fail_save_transcript: AtomicBool,
    _dir: tempfile::TempDir,
}

impl MemStore {
    fn new() -> Arc<MemStore> {
        Self::build(true, 12_000)
    }

    fn build(with_audio: bool, duration_ms: i64) -> Arc<MemStore> {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio.flac");
        std::fs::write(&path, b"fLaC-not-really-but-non-empty").unwrap();
        Arc::new(MemStore {
            audio: with_audio.then_some(path),
            duration_ms,
            statuses: Default::default(),
            history: Default::default(),
            transcripts: Default::default(),
            fail_save_transcript: AtomicBool::new(false),
            _dir: dir,
        })
    }

    fn status(&self, asset: &str) -> TranscriptionStatus {
        self.statuses
            .lock()
            .unwrap()
            .get(asset)
            .cloned()
            .unwrap_or_else(|| panic!("no status for {asset}"))
    }

    /// Distinct consecutive states saved for an asset.
    fn states(&self, asset: &str) -> Vec<JobState> {
        let mut out: Vec<JobState> = Vec::new();
        for (a, s) in self.history.lock().unwrap().iter() {
            if a == asset && out.last() != Some(&s.state) {
                out.push(s.state);
            }
        }
        out
    }

    fn seed(&self, asset: &str, status: TranscriptionStatus) {
        self.statuses
            .lock()
            .unwrap()
            .insert(asset.to_string(), status);
    }
}

impl TranscriptionStore for MemStore {
    fn audio_for_upload(&self, _asset_id: &str) -> Result<(PathBuf, i64), String> {
        match &self.audio {
            Some(p) => Ok((p.clone(), self.duration_ms)),
            None => Err("This media has no audio track to transcribe.".to_string()),
        }
    }
    fn load_status(&self, asset_id: &str) -> Option<TranscriptionStatus> {
        self.statuses.lock().unwrap().get(asset_id).cloned()
    }
    fn save_status(&self, asset_id: &str, status: &TranscriptionStatus) {
        self.statuses
            .lock()
            .unwrap()
            .insert(asset_id.to_string(), status.clone());
        self.history
            .lock()
            .unwrap()
            .push((asset_id.to_string(), status.clone()));
    }
    fn save_transcript(&self, asset_id: &str, transcript: &Transcript) -> Result<(), String> {
        if self.fail_save_transcript.load(Ordering::SeqCst) {
            return Err("disk full".to_string());
        }
        self.transcripts
            .lock()
            .unwrap()
            .insert(asset_id.to_string(), transcript.clone());
        Ok(())
    }
    fn all_statuses(&self) -> Vec<(String, TranscriptionStatus)> {
        let mut v: Vec<_> = self
            .statuses
            .lock()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        v.sort_by(|a, b| a.0.cmp(&b.0));
        v
    }
}

fn opts() -> TranscriptionOptions {
    TranscriptionOptions {
        poll_interval: Duration::from_millis(2),
        max_wait: Duration::from_secs(20),
        max_attempts: 3,
        retry_backoff: Duration::from_millis(1),
    }
}

fn manager(api: Arc<FakeApi>, store: Arc<MemStore>) -> TranscriptionManager {
    TranscriptionManager::new(api, store, opts())
}

async fn wait_until(what: &str, f: impl Fn() -> bool) {
    for _ in 0..5_000 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    panic!("timed out waiting until {what}");
}

async fn idle(m: &TranscriptionManager) {
    tokio::time::timeout(Duration::from_secs(20), m.wait_idle())
        .await
        .expect("jobs did not finish");
}

// ---------------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------------

#[tokio::test]
async fn happy_path_reports_every_state_and_cleans_up() {
    let (api, store) = (FakeApi::new(), MemStore::new());
    api.status
        .lock()
        .unwrap()
        .extend([Ok("queued"), Ok("processing"), Ok("completed")]);
    let m = manager(api.clone(), store.clone());

    let queued = m.start("a1", false).unwrap();
    assert_eq!(queued.state, JobState::Queued);
    assert_eq!(queued.provider, "soniox");
    assert!(m.is_running("a1"));
    idle(&m).await;

    assert_eq!(
        store.states("a1"),
        [
            JobState::Queued,
            JobState::Uploading,
            JobState::Processing,
            JobState::Completed
        ]
    );
    let st = store.status("a1");
    assert_eq!(st.state, JobState::Completed);
    assert_eq!(st.word_count, Some(2));
    assert_eq!(st.cleanup, CleanupState::Done);
    assert_eq!(
        (st.file_id.clone(), st.transcription_id.clone()),
        (None, None)
    );
    assert_eq!(st.audio_duration_ms, Some(4_000));
    assert_eq!(st.message, None);
    assert!(!m.is_running("a1"));

    // ids were persisted as soon as they were known (restart safety)
    let history = store.history.lock().unwrap().clone();
    assert!(history.iter().any(|(_, s)| s.state == JobState::Processing
        && s.file_id.is_some()
        && s.transcription_id.is_none()
        && s.cleanup == CleanupState::Pending));
    assert!(history
        .iter()
        .any(|(_, s)| s.state == JobState::Processing && s.transcription_id.is_some()));
    // the provider queue is surfaced honestly while we are "processing"
    assert!(history
        .iter()
        .any(|(_, s)| s.message.as_deref().is_some_and(|m| m.contains("queue"))));

    let t = store
        .transcripts
        .lock()
        .unwrap()
        .get("a1")
        .cloned()
        .unwrap();
    assert_eq!(
        t.words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>(),
        ["Hello", "world."]
    );
    assert_eq!(t.tokens.len(), 5);
    assert_eq!(
        (t.provider.as_str(), t.model.as_str(), t.fixture),
        ("soniox", "fake-model", false)
    );

    // remote objects are gone, deleted in the right order
    assert!(api.live_files().is_empty() && api.live_transcriptions().is_empty());
    let calls = api.calls();
    assert_eq!(calls.first().map(String::as_str), Some("upload_file"));
    assert_eq!(
        &calls[calls.len() - 3..],
        ["get_transcript", "delete_transcription", "delete_file"]
    );
    assert_eq!(api.count("get_transcription"), 3);
}

#[tokio::test]
async fn provider_error_status_fails_and_cleans_up() {
    let (api, store) = (FakeApi::new(), MemStore::new());
    api.status
        .lock()
        .unwrap()
        .extend([Ok("processing"), Ok("error")]);
    *api.remote_error.lock().unwrap() = Some(("invalid_audio_file", "Audio could not be decoded."));
    let m = manager(api.clone(), store.clone());
    m.start("a1", false).unwrap();
    idle(&m).await;

    let st = store.status("a1");
    assert_eq!(st.state, JobState::Failed);
    assert_eq!(st.error_kind, Some(ProviderErrorKind::Transcription));
    assert!(!st.retryable);
    assert!(st
        .message
        .as_deref()
        .unwrap()
        .contains("Audio could not be decoded"));
    assert_eq!(st.cleanup, CleanupState::Done);
    assert!(api.live_files().is_empty() && api.live_transcriptions().is_empty());
    assert_eq!(api.count("get_transcript"), 0);
    assert!(store.transcripts.lock().unwrap().is_empty());
}

#[tokio::test]
async fn unknown_remote_status_fails_instead_of_polling_forever() {
    let (api, store) = (FakeApi::new(), MemStore::new());
    *api.default_status.lock().unwrap() = "paused";
    let m = manager(api.clone(), store.clone());
    m.start("a1", false).unwrap();
    idle(&m).await;
    let st = store.status("a1");
    assert_eq!(st.state, JobState::Failed);
    assert!(st
        .message
        .as_deref()
        .unwrap()
        .contains("unknown transcription status"));
    assert_eq!(api.count("get_transcription"), 1);
    assert!(api.live_files().is_empty() && api.live_transcriptions().is_empty());
}

#[tokio::test]
async fn transient_failures_are_retried_then_succeed() {
    let (api, store) = (FakeApi::new(), MemStore::new());
    api.upload.lock().unwrap().push_back(Err(http(503)));
    api.create
        .lock()
        .unwrap()
        .push_back(Err(ProviderError::network("connection reset")));
    api.status
        .lock()
        .unwrap()
        .extend([Err(http(429)), Ok("completed")]);
    api.transcript
        .lock()
        .unwrap()
        .push_back(Err(ProviderError::timeout("downloading the transcript")));
    let m = manager(api.clone(), store.clone());
    m.start("a1", false).unwrap();
    idle(&m).await;

    let st = store.status("a1");
    assert_eq!(st.state, JobState::Completed);
    assert_eq!(st.attempts, 4);
    assert_eq!(st.message, None);
    assert_eq!(
        (
            api.count("upload_file"),
            api.count("create_transcription"),
            api.count("get_transcript")
        ),
        (2, 2, 2)
    );
    // the retry was visible to the user while it happened
    assert!(store.history.lock().unwrap().iter().any(|(_, s)| s
        .message
        .as_deref()
        .is_some_and(|m| m.contains("Retrying automatically"))));
    assert!(api.live_files().is_empty() && api.live_transcriptions().is_empty());
}

#[tokio::test]
async fn auth_failure_is_permanent_and_not_retried() {
    let (api, store) = (FakeApi::new(), MemStore::new());
    api.upload.lock().unwrap().push_back(Err(http(401)));
    let m = manager(api.clone(), store.clone());
    m.start("a1", false).unwrap();
    idle(&m).await;

    let st = store.status("a1");
    assert_eq!(st.state, JobState::Failed);
    assert_eq!(st.error_kind, Some(ProviderErrorKind::Auth));
    assert!(!st.retryable);
    assert!(st.message.as_deref().unwrap().contains("SONIOX_API_KEY"));
    assert_eq!(api.count("upload_file"), 1);
    // nothing was created remotely, so there is nothing to clean
    assert_eq!(st.cleanup, CleanupState::NotNeeded);
    assert_eq!(
        api.count("delete_file") + api.count("delete_transcription"),
        0
    );
    assert_eq!(
        store.states("a1"),
        [JobState::Queued, JobState::Uploading, JobState::Failed]
    );
}

#[tokio::test]
async fn exhausted_retries_end_in_a_retryable_failure() {
    let (api, store) = (FakeApi::new(), MemStore::new());
    api.upload
        .lock()
        .unwrap()
        .extend((0..10).map(|_| Err(http(503))));
    let m = manager(api.clone(), store.clone());
    m.start("a1", false).unwrap();
    idle(&m).await;

    let st = store.status("a1");
    assert_eq!(st.state, JobState::Failed);
    assert!(st.retryable && st.can_retry());
    assert_eq!(st.error_kind, Some(ProviderErrorKind::Server));
    assert_eq!(
        api.count("upload_file"),
        3,
        "max_attempts bounds the automatic retries"
    );

    // a manual retry starts a fresh job that can succeed
    api.upload.lock().unwrap().clear();
    let again = m.start("a1", false).unwrap();
    assert_eq!((again.state, again.attempts), (JobState::Queued, 0));
    idle(&m).await;
    assert_eq!(store.status("a1").state, JobState::Completed);
}

#[tokio::test]
async fn not_configured_client_fails_with_instructions() {
    let store = MemStore::new();
    let api = Arc::new(SonioxHttp::new(
        None,
        "https://api.soniox.com".into(),
        "stt-async-v5".into(),
    ));
    assert!(!api.is_configured());
    assert!(!format!("{api:?}").contains("Bearer"));
    let m = TranscriptionManager::new(api, store.clone(), opts());
    let st = m.start("a1", false).unwrap();
    assert_eq!(
        (st.provider.as_str(), st.model.as_str(), st.fixture),
        ("soniox", "stt-async-v5", false)
    );
    idle(&m).await;
    let st = store.status("a1");
    assert_eq!(st.state, JobState::Failed);
    assert_eq!(st.error_kind, Some(ProviderErrorKind::NotConfigured));
    assert!(!st.retryable);
    let msg = st.message.unwrap();
    assert!(
        msg.contains("SONIOX_API_KEY") && msg.contains("--fixture"),
        "{msg}"
    );
}

#[tokio::test]
async fn cancel_during_upload() {
    let (api, store) = (FakeApi::gated(), MemStore::new());
    let m = manager(api.clone(), store.clone());
    m.start("a1", false).unwrap();
    wait_until("the upload is in flight", || api.count("upload_file") == 1).await;
    assert_eq!(store.status("a1").state, JobState::Uploading);

    let st = tokio::time::timeout(Duration::from_secs(5), m.cancel("a1"))
        .await
        .expect("cancel must be prompt")
        .unwrap();
    assert_eq!(st.state, JobState::Cancelled);
    assert_eq!(st.error_kind, Some(ProviderErrorKind::Cancelled));
    assert!(!st.retryable && st.can_retry());
    assert_eq!(st.cleanup, CleanupState::NotNeeded);
    assert!(!m.is_running("a1"));
    assert_eq!(
        store.states("a1"),
        [JobState::Queued, JobState::Uploading, JobState::Cancelled]
    );
    assert_eq!(api.count("create_transcription"), 0);
}

#[tokio::test]
async fn cancel_during_polling_deletes_remote_objects() {
    let (api, store) = (FakeApi::new(), MemStore::new());
    *api.default_status.lock().unwrap() = "processing";
    let m = manager(api.clone(), store.clone());
    m.start("a1", false).unwrap();
    wait_until("the provider is polled", || {
        api.count("get_transcription") >= 2
    })
    .await;
    let running = store.status("a1");
    assert_eq!(running.state, JobState::Processing);
    assert!(running.file_id.is_some() && running.transcription_id.is_some());
    assert_eq!(
        (api.live_files().len(), api.live_transcriptions().len()),
        (1, 1)
    );

    let st = tokio::time::timeout(Duration::from_secs(5), m.cancel("a1"))
        .await
        .expect("cancel must be prompt")
        .unwrap();
    assert_eq!(st.state, JobState::Cancelled);
    assert_eq!(st.cleanup, CleanupState::Done);
    assert_eq!((st.file_id, st.transcription_id), (None, None));
    assert!(api.live_files().is_empty() && api.live_transcriptions().is_empty());
    assert!(store.transcripts.lock().unwrap().is_empty());

    // cancelling again (nothing running) just reports the status
    assert_eq!(m.cancel("a1").await.unwrap().state, JobState::Cancelled);
    assert!(m.cancel("unknown-asset").await.is_none());
}

#[tokio::test]
async fn cancel_while_waiting_for_a_worker_slot() {
    let (api, store) = (FakeApi::gated(), MemStore::new());
    let m = manager(api.clone(), store.clone());
    let n = MAX_CONCURRENT_JOBS + 2;
    for i in 0..n {
        m.start(&format!("a{i}"), false).unwrap();
    }
    wait_until("the worker slots are full", || {
        api.count("upload_file") == MAX_CONCURRENT_JOBS
    })
    .await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    // the rest are honestly still queued and nothing was sent for them
    assert_eq!(api.count("upload_file"), MAX_CONCURRENT_JOBS);
    let states: Vec<JobState> = (0..n)
        .map(|i| store.status(&format!("a{i}")).state)
        .collect();
    assert_eq!(
        states.iter().filter(|s| **s == JobState::Uploading).count(),
        MAX_CONCURRENT_JOBS
    );
    assert_eq!(states.iter().filter(|s| **s == JobState::Queued).count(), 2);

    let queued_asset = (0..n)
        .map(|i| format!("a{i}"))
        .find(|a| store.status(a).state == JobState::Queued)
        .unwrap();
    let st = m.cancel(&queued_asset).await.unwrap();
    assert_eq!(st.state, JobState::Cancelled);
    assert_eq!(
        store.states(&queued_asset),
        [JobState::Queued, JobState::Cancelled]
    );

    // let everything else through
    api.upload_gate.add_permits(100);
    idle(&m).await;
    let done = (0..n)
        .filter(|i| store.status(&format!("a{i}")).state == JobState::Completed)
        .count();
    assert_eq!(done, n - 1);
    assert!(api.live_files().is_empty() && api.live_transcriptions().is_empty());
}

#[tokio::test]
async fn poll_timeout_is_a_retryable_failure() {
    let (api, store) = (FakeApi::new(), MemStore::new());
    *api.default_status.lock().unwrap() = "processing";
    let m = TranscriptionManager::new(
        api.clone(),
        store.clone(),
        TranscriptionOptions {
            max_wait: Duration::from_millis(30),
            ..opts()
        },
    );
    m.start("a1", false).unwrap();
    idle(&m).await;
    let st = store.status("a1");
    assert_eq!(st.state, JobState::Failed);
    assert_eq!(st.error_kind, Some(ProviderErrorKind::Timeout));
    assert!(st.retryable);
    assert_eq!(st.cleanup, CleanupState::Done);
    assert!(api.live_files().is_empty() && api.live_transcriptions().is_empty());
}

#[tokio::test]
async fn failed_cleanup_is_recorded_and_retried_on_resume() {
    let (api, store) = (FakeApi::new(), MemStore::new());
    // deleting the file keeps failing (all automatic attempts)
    api.delete_file
        .lock()
        .unwrap()
        .extend((0..3).map(|_| Err(http(500))));
    let m = manager(api.clone(), store.clone());
    m.start("a1", false).unwrap();
    idle(&m).await;

    let st = store.status("a1");
    assert_eq!(
        st.state,
        JobState::Completed,
        "a cleanup problem must not turn a finished transcript into a failure"
    );
    assert_eq!(st.cleanup, CleanupState::Failed);
    assert!(st.file_id.is_some());
    assert_eq!(
        st.transcription_id, None,
        "the transcription itself was deleted"
    );
    assert_eq!(api.live_files().len(), 1);
    assert!(st.needs_cleanup());

    // "restart": a new manager over the same store retries the cleanup
    let m2 = manager(api.clone(), store.clone());
    m2.resume_pending().await;
    idle(&m2).await;
    let st = store.status("a1");
    assert_eq!(st.state, JobState::Completed);
    assert_eq!(st.cleanup, CleanupState::Done);
    assert_eq!(st.file_id, None);
    assert!(api.live_files().is_empty());
    assert_eq!(
        api.count("upload_file"),
        1,
        "resume must not redo a completed transcription"
    );
}

fn seeded(state: JobState, file: Option<&str>, tx: Option<&str>) -> TranscriptionStatus {
    let mut st = TranscriptionStatus::queued("soniox", "fake-model", false, 1_000);
    st.state = state;
    st.file_id = file.map(str::to_string);
    st.transcription_id = tx.map(str::to_string);
    if file.is_some() || tx.is_some() {
        st.cleanup = CleanupState::Pending;
    }
    st
}

#[tokio::test]
async fn processing_job_resumes_after_restart_without_reuploading() {
    let (api, store) = (FakeApi::new(), MemStore::new());
    api.files.lock().unwrap().insert("file-old".into());
    api.transcriptions.lock().unwrap().insert("tx-old".into());
    store.seed(
        "a1",
        seeded(JobState::Processing, Some("file-old"), Some("tx-old")),
    );
    api.status
        .lock()
        .unwrap()
        .extend([Ok("processing"), Ok("completed")]);

    let m = manager(api.clone(), store.clone());
    m.resume_pending().await;
    assert!(m.is_running("a1"));
    idle(&m).await;

    let st = store.status("a1");
    assert_eq!(st.state, JobState::Completed);
    assert_eq!(st.word_count, Some(2));
    assert_eq!(st.cleanup, CleanupState::Done);
    assert_eq!(st.created_at_ms, 1_000);
    assert_eq!(
        api.count("upload_file") + api.count("create_transcription"),
        0
    );
    assert!(store.transcripts.lock().unwrap().contains_key("a1"));
    assert!(api.live_files().is_empty() && api.live_transcriptions().is_empty());
}

#[tokio::test]
async fn interrupted_upload_restarts_and_removes_leftovers() {
    let (api, store) = (FakeApi::new(), MemStore::new());
    api.files.lock().unwrap().insert("file-old".into());
    store.seed("a1", seeded(JobState::Uploading, Some("file-old"), None));
    store.seed("a2", seeded(JobState::Queued, None, None));
    // a job that was processing but whose remote transcription has vanished
    api.files.lock().unwrap().insert("file-gone".into());
    store.seed(
        "a3",
        seeded(JobState::Processing, Some("file-gone"), Some("tx-gone")),
    );

    let m = manager(api.clone(), store.clone());
    m.resume_pending().await;
    idle(&m).await;

    for a in ["a1", "a2", "a3"] {
        let st = store.status(a);
        assert_eq!(st.state, JobState::Completed, "{a}");
        assert_eq!(st.cleanup, CleanupState::Done, "{a}");
        assert_eq!(st.created_at_ms, 1_000, "{a}");
    }
    assert_eq!(api.count("upload_file"), 3);
    assert!(
        api.live_files().is_empty(),
        "leftover uploads must be deleted: {:?}",
        api.live_files()
    );
    assert!(api.live_transcriptions().is_empty());
}

#[tokio::test]
async fn purge_deletes_leftovers_and_stops_running_jobs() {
    let (api, store) = (FakeApi::new(), MemStore::new());
    // a failed job whose cleanup failed earlier
    api.files.lock().unwrap().insert("file-x".into());
    api.transcriptions.lock().unwrap().insert("tx-x".into());
    let mut st = seeded(JobState::Failed, Some("file-x"), Some("tx-x"));
    st.cleanup = CleanupState::Failed;
    store.seed("old", st);
    // and a job that is currently running
    *api.default_status.lock().unwrap() = "processing";
    let m = manager(api.clone(), store.clone());
    m.start("live", false).unwrap();
    wait_until("the live job is processing", || {
        api.count("get_transcription") >= 1
    })
    .await;
    assert_eq!(
        (api.live_files().len(), api.live_transcriptions().len()),
        (2, 2)
    );

    m.purge("old").await;
    let st = store.status("old");
    assert_eq!(
        (st.state, st.cleanup),
        (JobState::Failed, CleanupState::Done)
    );
    assert_eq!((st.file_id, st.transcription_id), (None, None));

    m.purge("live").await;
    let st = store.status("live");
    assert_eq!(
        (st.state, st.cleanup),
        (JobState::Cancelled, CleanupState::Done)
    );
    assert!(!m.is_running("live"));
    assert!(api.live_files().is_empty() && api.live_transcriptions().is_empty());

    // purging something unknown or already clean is harmless
    m.purge("nope").await;
    m.purge("old").await;
}

#[tokio::test]
async fn orphaned_active_status_can_be_cancelled_and_cleaned() {
    let (api, store) = (FakeApi::new(), MemStore::new());
    api.files.lock().unwrap().insert("file-o".into());
    api.transcriptions.lock().unwrap().insert("tx-o".into());
    store.seed(
        "a1",
        seeded(JobState::Processing, Some("file-o"), Some("tx-o")),
    );
    let m = manager(api.clone(), store.clone());
    // no resume_pending: there is no task for this status
    let st = m.cancel("a1").await.unwrap();
    assert_eq!(
        (st.state, st.cleanup),
        (JobState::Cancelled, CleanupState::Done)
    );
    assert!(api.live_files().is_empty() && api.live_transcriptions().is_empty());
}

#[tokio::test]
async fn start_is_idempotent_and_force_redoes_a_transcript() {
    let (api, store) = (FakeApi::gated(), MemStore::new());
    let m = manager(api.clone(), store.clone());
    m.start("a1", false).unwrap();
    wait_until("the upload is in flight", || api.count("upload_file") == 1).await;
    // starting again while active is a no-op that reports the live status
    let again = m.start("a1", true).unwrap();
    assert_eq!(again.state, JobState::Uploading);
    api.upload_gate.add_permits(100);
    idle(&m).await;
    assert_eq!(api.count("upload_file"), 1);
    assert_eq!(store.status("a1").state, JobState::Completed);

    // completed + no force: nothing happens
    let st = m.start("a1", false).unwrap();
    assert_eq!(st.state, JobState::Completed);
    assert!(!m.is_running("a1"));
    assert_eq!(api.count("upload_file"), 1);

    // force: a fresh job
    let st = m.start("a1", true).unwrap();
    assert_eq!(st.state, JobState::Queued);
    idle(&m).await;
    assert_eq!(api.count("upload_file"), 2);
    assert_eq!(store.status("a1").state, JobState::Completed);
    assert!(api.live_files().is_empty() && api.live_transcriptions().is_empty());
}

#[tokio::test]
async fn start_fails_fast_without_audio() {
    let (api, store) = (FakeApi::new(), MemStore::build(false, 0));
    let m = manager(api.clone(), store.clone());
    let err = m.start("a1", false).unwrap_err();
    assert_eq!(err.kind, ProviderErrorKind::Io);
    assert!(err.message.contains("no audio track"));
    assert!(
        store.load_status("a1").is_none(),
        "no job may be recorded for media that cannot be transcribed"
    );
    assert!(!m.is_running("a1"));
    assert!(api.calls().is_empty());
}

#[tokio::test]
async fn silent_media_completes_with_zero_words() {
    let (api, store) = (FakeApi::new(), MemStore::new());
    api.transcript.lock().unwrap().push_back(Ok(Vec::new()));
    let m = manager(api.clone(), store.clone());
    m.start("a1", false).unwrap();
    idle(&m).await;
    let st = store.status("a1");
    assert_eq!(st.state, JobState::Completed);
    assert_eq!(st.word_count, Some(0));
    assert!(st
        .message
        .as_deref()
        .unwrap()
        .contains("No speech detected"));
    assert!(store
        .transcripts
        .lock()
        .unwrap()
        .get("a1")
        .unwrap()
        .words
        .is_empty());
    assert_eq!(st.cleanup, CleanupState::Done);
}

#[tokio::test]
async fn transcript_that_cannot_be_saved_fails_retryably_and_cleans_up() {
    let (api, store) = (FakeApi::new(), MemStore::new());
    store.fail_save_transcript.store(true, Ordering::SeqCst);
    let m = manager(api.clone(), store.clone());
    m.start("a1", false).unwrap();
    idle(&m).await;
    let st = store.status("a1");
    assert_eq!(st.state, JobState::Failed);
    assert_eq!(st.error_kind, Some(ProviderErrorKind::Io));
    assert!(st.retryable);
    assert!(st.message.as_deref().unwrap().contains("disk full"));
    assert_eq!(st.cleanup, CleanupState::Done);
    assert!(api.live_files().is_empty() && api.live_transcriptions().is_empty());
}

#[tokio::test]
async fn fixture_adapter_end_to_end() {
    let store = MemStore::build(true, 20_000);
    let api = Arc::new(FixtureSpeech::new(Duration::ZERO));
    let m = TranscriptionManager::new(api.clone(), store.clone(), opts());
    let st = m.start("asset-42", false).unwrap();
    assert!(st.fixture);
    assert_eq!(st.provider, "fixture");
    idle(&m).await;

    assert_eq!(
        store.states("asset-42"),
        [
            JobState::Queued,
            JobState::Uploading,
            JobState::Processing,
            JobState::Completed
        ]
    );
    let st = store.status("asset-42");
    assert_eq!(st.cleanup, CleanupState::Done);
    assert!(st.fixture);
    assert_eq!(st.audio_duration_ms, Some(20_000));

    let t = store
        .transcripts
        .lock()
        .unwrap()
        .get("asset-42")
        .cloned()
        .unwrap();
    assert!(t.fixture);
    assert_eq!(t.provider, "fixture");
    assert_eq!(st.word_count, Some(t.words.len() as u32));
    assert!(t.words.len() > 20, "{} words", t.words.len());
    assert!(t.words.iter().all(|w| w.end.as_ms() <= 20_000));
    assert_eq!(t.words[0].text, "This");
    assert_eq!(t.speakers, ["1", "2"]);

    // the fixture behaves like a real provider: objects existed and were deleted
    assert!(api.live_files().is_empty() && api.live_transcriptions().is_empty());
    let calls = api.calls();
    assert!(calls[0].starts_with("upload_file "));
    assert!(calls.iter().any(|c| c.starts_with("delete_transcription ")));
    assert!(calls.last().unwrap().starts_with("delete_file "));

    // deterministic: a second run for the same asset yields the same transcript
    m.start("asset-42", true).unwrap();
    idle(&m).await;
    assert_eq!(
        store
            .transcripts
            .lock()
            .unwrap()
            .get("asset-42")
            .unwrap()
            .words,
        t.words
    );
}

#[tokio::test]
async fn fixture_adapter_rejects_premature_and_unknown_requests() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.flac");
    std::fs::write(&path, b"x").unwrap();
    let api = FixtureSpeech::new(Duration::ZERO);
    assert_eq!(
        api.upload_file(&dir.path().join("missing.flac"), "missing.flac", 1000)
            .await
            .unwrap_err()
            .kind,
        ProviderErrorKind::Io
    );
    let file = api.upload_file(&path, "a.flac", 5_000).await.unwrap();
    let tx = api.create_transcription(&file, "ref").await.unwrap();
    assert_eq!(tx.status, "queued");
    assert_eq!(
        api.get_transcript(&tx.id).await.unwrap_err().kind,
        ProviderErrorKind::Conflict
    );
    assert_eq!(
        api.get_transcription("nope").await.unwrap_err().kind,
        ProviderErrorKind::NotFound
    );
    assert_eq!(
        api.create_transcription("nope", "ref")
            .await
            .unwrap_err()
            .kind,
        ProviderErrorKind::NotFound
    );
    let statuses = [
        api.get_transcription(&tx.id).await.unwrap().status,
        api.get_transcription(&tx.id).await.unwrap().status,
        api.get_transcription(&tx.id).await.unwrap().status,
    ];
    assert_eq!(statuses, ["queued", "processing", "completed"]);
    assert!(!api.get_transcript(&tx.id).await.unwrap().tokens.is_empty());
    assert_eq!(
        (api.live_files().len(), api.live_transcriptions().len()),
        (1, 1)
    );
    api.delete_transcription(&tx.id).await.unwrap();
    api.delete_file(&file).await.unwrap();
    // deleting again is fine
    api.delete_file(&file).await.unwrap();
    assert!(api.live_files().is_empty() && api.live_transcriptions().is_empty());
}
