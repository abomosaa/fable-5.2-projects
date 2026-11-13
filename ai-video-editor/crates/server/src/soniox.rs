//! Speech provider adapters.
//!
//! [`SpeechApi`] is the narrow seam between the transcription job runner and a
//! speech-to-text provider. Two implementations ship:
//!
//! * [`SonioxHttp`] – the real Soniox integration (Files API + asynchronous
//!   transcriptions) over HTTPS. The API key never leaves this process and is never
//!   logged.
//! * [`FixtureSpeech`] – a deterministic in-memory stand-in that produces clearly
//!   labelled synthetic tokens. Used by fixture mode and tests; needs no network.

use async_trait::async_trait;
use cutline_core::soniox::{
    classify_http_error, fixture_tokens, ProviderError, ProviderErrorKind, SonioxFile, SonioxToken,
    SonioxTranscript, SonioxTranscription, DEFAULT_MODEL,
};
use serde::de::DeserializeOwned;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

#[async_trait]
pub trait SpeechApi: Send + Sync + 'static {
    /// `"soniox"` or `"fixture"`.
    fn provider(&self) -> &'static str;
    fn model(&self) -> String;
    fn is_fixture(&self) -> bool;
    /// Upload an audio file; returns the remote file id.
    async fn upload_file(
        &self,
        path: &Path,
        filename: &str,
        audio_duration_ms: i64,
    ) -> Result<String, ProviderError>;
    async fn create_transcription(
        &self,
        file_id: &str,
        client_reference_id: &str,
    ) -> Result<SonioxTranscription, ProviderError>;
    async fn get_transcription(&self, id: &str) -> Result<SonioxTranscription, ProviderError>;
    async fn get_transcript(&self, id: &str) -> Result<SonioxTranscript, ProviderError>;
    /// Deleting something that is already gone is a success.
    async fn delete_transcription(&self, id: &str) -> Result<(), ProviderError>;
    async fn delete_file(&self, id: &str) -> Result<(), ProviderError>;
}

// ---------------------------------------------------------------------------------
// Real Soniox client
// ---------------------------------------------------------------------------------

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Uploads stream large files; allow them a long time but not forever.
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(60 * 60);

/// Soniox REST client (`POST /v1/files`, `POST|GET|DELETE /v1/transcriptions…`).
pub struct SonioxHttp {
    api_key: Option<String>,
    base_url: String,
    model: String,
    client: reqwest::Client,
}

impl std::fmt::Debug for SonioxHttp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SonioxHttp")
            .field(
                "api_key",
                &if self.api_key.is_some() {
                    "[set]"
                } else {
                    "[not set]"
                },
            )
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .finish()
    }
}

impl SonioxHttp {
    /// `api_key: None` yields a client whose every call fails with
    /// [`ProviderErrorKind::NotConfigured`] and an actionable message.
    pub fn new(api_key: Option<String>, base_url: String, model: String) -> SonioxHttp {
        let api_key = api_key
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty());
        let base_url = base_url.trim().trim_end_matches('/').to_string();
        let model = if model.trim().is_empty() {
            DEFAULT_MODEL.to_string()
        } else {
            model.trim().to_string()
        };
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .user_agent(concat!("cutline/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        SonioxHttp {
            api_key,
            base_url,
            model,
            client,
        }
    }

    pub fn is_configured(&self) -> bool {
        self.api_key.is_some()
    }

    fn key(&self) -> Result<&str, ProviderError> {
        self.api_key
            .as_deref()
            .ok_or_else(ProviderError::not_configured)
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    /// Remote ids end up in URL paths; refuse anything that is not a plain id.
    fn check_id(id: &str) -> Result<&str, ProviderError> {
        if id.is_empty()
            || id.len() > 128
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(ProviderError::new(
                ProviderErrorKind::InvalidRequest,
                "Invalid Soniox object id.",
                false,
            ));
        }
        Ok(id)
    }

    fn map_transport(e: reqwest::Error, what: &str) -> ProviderError {
        if e.is_timeout() {
            ProviderError::timeout(what)
        } else {
            // `without_url` keeps hostnames/paths out of user-facing text; the key is
            // only ever sent as a header and is not part of reqwest's error output.
            ProviderError::network(&e.without_url().to_string())
        }
    }

    async fn read<T: DeserializeOwned>(
        resp: reqwest::Response,
        what: &str,
    ) -> Result<T, ProviderError> {
        let status = resp.status();
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| Self::map_transport(e, what))?;
        if !status.is_success() {
            return Err(classify_http_error(
                status.as_u16(),
                &String::from_utf8_lossy(&bytes),
            ));
        }
        serde_json::from_slice::<T>(&bytes)
            .map_err(|e| ProviderError::invalid_response(&format!("while {what}: {e}")))
    }

    async fn delete(&self, path: String, what: &str) -> Result<(), ProviderError> {
        let key = self.key()?;
        let resp = self
            .client
            .delete(self.url(&path))
            .bearer_auth(key)
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(|e| Self::map_transport(e, what))?;
        let status = resp.status();
        if status.is_success() || status.as_u16() == 404 {
            return Ok(());
        }
        let body = resp.text().await.unwrap_or_default();
        Err(classify_http_error(status.as_u16(), &body))
    }
}

#[async_trait]
impl SpeechApi for SonioxHttp {
    fn provider(&self) -> &'static str {
        "soniox"
    }

    fn model(&self) -> String {
        self.model.clone()
    }

    fn is_fixture(&self) -> bool {
        false
    }

    async fn upload_file(
        &self,
        path: &Path,
        filename: &str,
        _audio_duration_ms: i64,
    ) -> Result<String, ProviderError> {
        let key = self.key()?;
        let what = "uploading audio";
        let file = tokio::fs::File::open(path).await.map_err(|e| {
            ProviderError::io(&format!(
                "Could not open the extracted audio for upload: {e}"
            ))
        })?;
        let len = file
            .metadata()
            .await
            .map_err(|e| {
                ProviderError::io(&format!(
                    "Could not read the extracted audio for upload: {e}"
                ))
            })?
            .len();
        if len == 0 {
            return Err(ProviderError::io(
                "The extracted audio is empty; there is nothing to transcribe.",
            ));
        }
        // Streamed from disk: large files are never held in memory.
        let body = reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::with_capacity(
            file,
            256 * 1024,
        ));
        let mime = mime_guess::from_path(filename).first_or_octet_stream();
        let part = reqwest::multipart::Part::stream_with_length(body, len)
            .file_name(filename.to_string())
            .mime_str(mime.as_ref())
            .map_err(|e| ProviderError::io(&format!("Could not prepare the upload: {e}")))?;
        let form = reqwest::multipart::Form::new().part("file", part);
        let resp = self
            .client
            .post(self.url("/v1/files"))
            .bearer_auth(key)
            .multipart(form)
            .timeout(UPLOAD_TIMEOUT)
            .send()
            .await
            .map_err(|e| Self::map_transport(e, what))?;
        let file: SonioxFile = Self::read(resp, what).await?;
        if file.id.is_empty() {
            return Err(ProviderError::invalid_response(
                "the upload response has no file id",
            ));
        }
        Ok(file.id)
    }

    async fn create_transcription(
        &self,
        file_id: &str,
        client_reference_id: &str,
    ) -> Result<SonioxTranscription, ProviderError> {
        let key = self.key()?;
        let what = "creating the transcription";
        let reference: String = client_reference_id.chars().take(256).collect();
        let body = serde_json::json!({
            "model": self.model,
            "file_id": file_id,
            "enable_speaker_diarization": true,
            "enable_language_identification": true,
            "client_reference_id": reference,
        });
        let resp = self
            .client
            .post(self.url("/v1/transcriptions"))
            .bearer_auth(key)
            .json(&body)
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(|e| Self::map_transport(e, what))?;
        Self::read(resp, what).await
    }

    async fn get_transcription(&self, id: &str) -> Result<SonioxTranscription, ProviderError> {
        let key = self.key()?;
        let what = "checking the transcription status";
        let id = Self::check_id(id)?;
        let resp = self
            .client
            .get(self.url(&format!("/v1/transcriptions/{id}")))
            .bearer_auth(key)
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(|e| Self::map_transport(e, what))?;
        Self::read(resp, what).await
    }

    async fn get_transcript(&self, id: &str) -> Result<SonioxTranscript, ProviderError> {
        let key = self.key()?;
        let what = "downloading the transcript";
        let id = Self::check_id(id)?;
        let resp = self
            .client
            .get(self.url(&format!("/v1/transcriptions/{id}/transcript")))
            .bearer_auth(key)
            // transcripts of long recordings are large; give the download more time
            .timeout(REQUEST_TIMEOUT * 5)
            .send()
            .await
            .map_err(|e| Self::map_transport(e, what))?;
        Self::read(resp, what).await
    }

    async fn delete_transcription(&self, id: &str) -> Result<(), ProviderError> {
        let id = Self::check_id(id)?;
        self.delete(
            format!("/v1/transcriptions/{id}"),
            "deleting the remote transcription",
        )
        .await
    }

    async fn delete_file(&self, id: &str) -> Result<(), ProviderError> {
        let id = Self::check_id(id)?;
        self.delete(format!("/v1/files/{id}"), "deleting the uploaded audio")
            .await
    }
}

// ---------------------------------------------------------------------------------
// Fixture adapter
// ---------------------------------------------------------------------------------

struct FixtureFile {
    filename: String,
    duration_ms: i64,
}

struct FixtureJob {
    file_id: String,
    reference: String,
    filename: String,
    duration_ms: i64,
    polls: u32,
}

#[derive(Default)]
struct FixtureState {
    next_id: u64,
    files: BTreeMap<String, FixtureFile>,
    jobs: BTreeMap<String, FixtureJob>,
    calls: Vec<String>,
}

/// Deterministic in-memory speech provider. It behaves like the real API (ids,
/// queued → processing → completed, deletable remote objects) but its "transcripts"
/// are synthetic [`fixture_tokens`]. Nothing is sent anywhere.
pub struct FixtureSpeech {
    step_delay: Duration,
    state: Mutex<FixtureState>,
}

pub const FIXTURE_MODEL: &str = "fixture-stt";

impl FixtureSpeech {
    /// `step_delay` is slept before each state-changing answer so a UI can show the
    /// intermediate states; tests pass `Duration::ZERO`.
    pub fn new(step_delay: Duration) -> FixtureSpeech {
        FixtureSpeech {
            step_delay,
            state: Mutex::new(FixtureState::default()),
        }
    }

    /// Ids of uploaded files that have not been deleted.
    pub fn live_files(&self) -> Vec<String> {
        self.state.lock().unwrap().files.keys().cloned().collect()
    }

    /// Ids of transcriptions that have not been deleted.
    pub fn live_transcriptions(&self) -> Vec<String> {
        self.state.lock().unwrap().jobs.keys().cloned().collect()
    }

    /// Chronological log of API calls, e.g. `"upload_file clip.flac"`.
    pub fn calls(&self) -> Vec<String> {
        self.state.lock().unwrap().calls.clone()
    }

    async fn pause(&self) {
        if !self.step_delay.is_zero() {
            tokio::time::sleep(self.step_delay).await;
        }
    }

    fn describe(id: &str, job: &FixtureJob, status: &str) -> SonioxTranscription {
        SonioxTranscription {
            id: id.to_string(),
            status: status.to_string(),
            created_at: None,
            model: FIXTURE_MODEL.to_string(),
            filename: Some(job.filename.clone()),
            audio_url: None,
            file_id: Some(job.file_id.clone()),
            audio_duration_ms: if status == "queued" {
                None
            } else {
                Some(job.duration_ms)
            },
            error_type: None,
            error_message: None,
            language_hints: None,
            enable_speaker_diarization: Some(true),
            enable_language_identification: Some(true),
            client_reference_id: Some(job.reference.clone()),
        }
    }

    fn not_found(what: &str) -> ProviderError {
        classify_http_error(404, &format!("{{\"status_code\":404,\"error_type\":\"not_found\",\"message\":\"{what} not found in the fixture adapter.\"}}"))
    }
}

#[async_trait]
impl SpeechApi for FixtureSpeech {
    fn provider(&self) -> &'static str {
        "fixture"
    }

    fn model(&self) -> String {
        FIXTURE_MODEL.to_string()
    }

    fn is_fixture(&self) -> bool {
        true
    }

    async fn upload_file(
        &self,
        path: &Path,
        filename: &str,
        audio_duration_ms: i64,
    ) -> Result<String, ProviderError> {
        // Behave like the real thing: the audio must actually exist.
        let meta = tokio::fs::metadata(path).await.map_err(|e| {
            ProviderError::io(&format!(
                "Could not open the extracted audio for upload: {e}"
            ))
        })?;
        if meta.len() == 0 {
            return Err(ProviderError::io(
                "The extracted audio is empty; there is nothing to transcribe.",
            ));
        }
        self.pause().await;
        let mut s = self.state.lock().unwrap();
        s.next_id += 1;
        let id = format!("fixture-file-{}", s.next_id);
        s.calls.push(format!("upload_file {filename}"));
        s.files.insert(
            id.clone(),
            FixtureFile {
                filename: filename.to_string(),
                duration_ms: audio_duration_ms.max(0),
            },
        );
        Ok(id)
    }

    async fn create_transcription(
        &self,
        file_id: &str,
        client_reference_id: &str,
    ) -> Result<SonioxTranscription, ProviderError> {
        let mut s = self.state.lock().unwrap();
        s.calls.push(format!("create_transcription {file_id}"));
        let (filename, duration_ms) = match s.files.get(file_id) {
            Some(f) => (f.filename.clone(), f.duration_ms),
            None => return Err(Self::not_found("File")),
        };
        s.next_id += 1;
        let id = format!("fixture-transcription-{}", s.next_id);
        let job = FixtureJob {
            file_id: file_id.to_string(),
            reference: client_reference_id.to_string(),
            filename,
            duration_ms,
            polls: 0,
        };
        let out = Self::describe(&id, &job, "queued");
        s.jobs.insert(id, job);
        Ok(out)
    }

    async fn get_transcription(&self, id: &str) -> Result<SonioxTranscription, ProviderError> {
        self.pause().await;
        let mut s = self.state.lock().unwrap();
        s.calls.push(format!("get_transcription {id}"));
        let job = s
            .jobs
            .get_mut(id)
            .ok_or_else(|| Self::not_found("Transcription"))?;
        job.polls += 1;
        // 1st poll: still queued, 2nd: processing, 3rd and later: completed
        let status = match job.polls {
            1 => "queued",
            2 => "processing",
            _ => "completed",
        };
        Ok(Self::describe(id, job, status))
    }

    async fn get_transcript(&self, id: &str) -> Result<SonioxTranscript, ProviderError> {
        let mut s = self.state.lock().unwrap();
        s.calls.push(format!("get_transcript {id}"));
        let job = s
            .jobs
            .get(id)
            .ok_or_else(|| Self::not_found("Transcription"))?;
        if job.polls < 3 {
            return Err(classify_http_error(409, "{\"status_code\":409,\"error_type\":\"invalid_state\",\"message\":\"The transcription is not completed yet.\"}"));
        }
        let tokens: Vec<SonioxToken> = fixture_tokens(job.duration_ms, &job.reference);
        let text: String = tokens.iter().map(|t| t.text.as_str()).collect();
        Ok(SonioxTranscript {
            id: id.to_string(),
            text,
            tokens,
        })
    }

    async fn delete_transcription(&self, id: &str) -> Result<(), ProviderError> {
        let mut s = self.state.lock().unwrap();
        s.calls.push(format!("delete_transcription {id}"));
        s.jobs.remove(id);
        Ok(())
    }

    async fn delete_file(&self, id: &str) -> Result<(), ProviderError> {
        let mut s = self.state.lock().unwrap();
        s.calls.push(format!("delete_file {id}"));
        s.files.remove(id);
        Ok(())
    }
}
