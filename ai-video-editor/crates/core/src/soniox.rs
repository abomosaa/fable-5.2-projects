//! Soniox speech-to-text: wire types, response/state normalisation and the
//! transcription job state model.
//!
//! This module is pure. The HTTP client lives in the server crate; everything that
//! decides *what a response means* lives here so it can be tested without a network:
//!
//! * lenient serde types for the REST API (`https://api.soniox.com/v1/...`)
//! * [`remote_status`] / [`classify_http_error`] – provider state and error normalisation
//! * [`tokens_to_transcript`] – sub-word tokens → word-level [`Transcript`]
//! * [`TranscriptionStatus`] – the honest job state shown in the UI
//! * [`fixture_tokens`] – deterministic, clearly synthetic tokens for fixture mode

use crate::time::SourceTime;
use crate::transcript::{RawToken, Transcript, Word};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

/// The asynchronous Soniox model used for imported media.
pub const DEFAULT_MODEL: &str = "stt-async-v5";
pub const DEFAULT_BASE_URL: &str = "https://api.soniox.com";

// ---------------------------------------------------------------------------------
// lenient deserialisers
// ---------------------------------------------------------------------------------

fn de_string_or_number<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(match Option::<Value>::deserialize(d)? {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s),
        Some(Value::Number(n)) => Some(match (n.as_i64(), n.as_f64()) {
            (Some(i), _) => i.to_string(),
            (None, Some(f)) if f.fract() == 0.0 => (f as i64).to_string(),
            _ => n.to_string(),
        }),
        _ => None,
    })
}

fn de_opt_i64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    Ok(match Option::<Value>::deserialize(d)? {
        Some(Value::Number(n)) => n.as_i64().or_else(|| {
            n.as_f64()
                .filter(|f| f.is_finite())
                .map(|f| f.round() as i64)
        }),
        Some(Value::String(s)) => s
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|f| f.is_finite())
            .map(|f| f.round() as i64),
        _ => None,
    })
}

fn de_opt_f64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    Ok(match Option::<Value>::deserialize(d)? {
        Some(Value::Number(n)) => n.as_f64().filter(|f| f.is_finite()),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok().filter(|f| f.is_finite()),
        _ => None,
    })
}

fn de_string_lossy<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(match Option::<Value>::deserialize(d)? {
        Some(Value::String(s)) => s,
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    })
}

fn de_opt_string<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(match Option::<Value>::deserialize(d)? {
        Some(Value::String(s)) => Some(s),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    })
}

fn de_validation_errors<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<Vec<SonioxValidationError>, D::Error> {
    let v = Option::<Value>::deserialize(d)?;
    let Some(Value::Array(items)) = v else {
        return Ok(Vec::new());
    };
    Ok(items
        .into_iter()
        .filter_map(|item| match item {
            Value::String(s) => Some(SonioxValidationError {
                error_type: None,
                location: None,
                message: Some(s),
            }),
            Value::Object(_) => serde_json::from_value::<SonioxValidationError>(item).ok(),
            _ => None,
        })
        .collect())
}

// ---------------------------------------------------------------------------------
// wire types
// ---------------------------------------------------------------------------------

/// One token of `GET /v1/transcriptions/{id}/transcript`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SonioxToken {
    #[serde(deserialize_with = "de_string_lossy")]
    pub text: String,
    #[serde(
        deserialize_with = "de_opt_i64",
        skip_serializing_if = "Option::is_none"
    )]
    pub start_ms: Option<i64>,
    #[serde(
        deserialize_with = "de_opt_i64",
        skip_serializing_if = "Option::is_none"
    )]
    pub end_ms: Option<i64>,
    #[serde(
        deserialize_with = "de_opt_f64",
        skip_serializing_if = "Option::is_none"
    )]
    pub confidence: Option<f64>,
    /// Speaker id; Soniox returns a string, older payloads a number — both accepted.
    #[serde(
        deserialize_with = "de_string_or_number",
        skip_serializing_if = "Option::is_none"
    )]
    pub speaker: Option<String>,
    #[serde(
        deserialize_with = "de_opt_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub language: Option<String>,
    #[serde(
        deserialize_with = "de_opt_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub translation_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_audio_event: Option<bool>,
}

/// `GET /v1/transcriptions/{id}/transcript`
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SonioxTranscript {
    #[serde(deserialize_with = "de_string_lossy")]
    pub id: String,
    #[serde(deserialize_with = "de_string_lossy")]
    pub text: String,
    pub tokens: Vec<SonioxToken>,
}

/// `POST /v1/transcriptions` and `GET /v1/transcriptions/{id}`
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SonioxTranscription {
    #[serde(deserialize_with = "de_string_lossy")]
    pub id: String,
    /// `"queued" | "processing" | "completed" | "error"`
    #[serde(deserialize_with = "de_string_lossy")]
    pub status: String,
    #[serde(deserialize_with = "de_opt_string")]
    pub created_at: Option<String>,
    #[serde(deserialize_with = "de_string_lossy")]
    pub model: String,
    #[serde(deserialize_with = "de_opt_string")]
    pub filename: Option<String>,
    #[serde(deserialize_with = "de_opt_string")]
    pub audio_url: Option<String>,
    #[serde(deserialize_with = "de_opt_string")]
    pub file_id: Option<String>,
    /// "Only available after processing begins."
    #[serde(deserialize_with = "de_opt_i64")]
    pub audio_duration_ms: Option<i64>,
    #[serde(deserialize_with = "de_opt_string")]
    pub error_type: Option<String>,
    #[serde(deserialize_with = "de_opt_string")]
    pub error_message: Option<String>,
    pub language_hints: Option<Vec<String>>,
    pub enable_speaker_diarization: Option<bool>,
    pub enable_language_identification: Option<bool>,
    #[serde(deserialize_with = "de_opt_string")]
    pub client_reference_id: Option<String>,
}

/// `POST /v1/files`
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SonioxFile {
    #[serde(deserialize_with = "de_string_lossy")]
    pub id: String,
    #[serde(deserialize_with = "de_opt_string")]
    pub filename: Option<String>,
    #[serde(deserialize_with = "de_opt_i64")]
    pub size: Option<i64>,
    #[serde(deserialize_with = "de_opt_string")]
    pub created_at: Option<String>,
    #[serde(deserialize_with = "de_opt_string")]
    pub client_reference_id: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SonioxValidationError {
    #[serde(deserialize_with = "de_opt_string")]
    pub error_type: Option<String>,
    #[serde(deserialize_with = "de_opt_string")]
    pub location: Option<String>,
    #[serde(deserialize_with = "de_opt_string")]
    pub message: Option<String>,
}

/// Error body returned with non-2xx responses.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SonioxErrorBody {
    #[serde(deserialize_with = "de_opt_i64")]
    pub status_code: Option<i64>,
    #[serde(deserialize_with = "de_opt_string")]
    pub error_type: Option<String>,
    #[serde(deserialize_with = "de_opt_string")]
    pub message: Option<String>,
    #[serde(deserialize_with = "de_validation_errors")]
    pub validation_errors: Vec<SonioxValidationError>,
    #[serde(deserialize_with = "de_opt_string")]
    pub request_id: Option<String>,
}

// ---------------------------------------------------------------------------------
// status + error normalisation
// ---------------------------------------------------------------------------------

/// Normalised remote transcription state.
#[derive(Clone, Debug, PartialEq)]
pub enum RemoteStatus {
    Queued,
    Processing,
    Completed,
    Error {
        error_type: Option<String>,
        message: String,
    },
}

/// Normalise a transcription object's status. Anything that is not one of the four
/// documented statuses becomes an error — an unknown state must never look like
/// endless "processing".
pub fn remote_status(t: &SonioxTranscription) -> RemoteStatus {
    match t.status.trim().to_ascii_lowercase().as_str() {
        "queued" => RemoteStatus::Queued,
        "processing" => RemoteStatus::Processing,
        "completed" => RemoteStatus::Completed,
        "error" => RemoteStatus::Error {
            error_type: t.error_type.clone().filter(|s| !s.trim().is_empty()),
            message: t
                .error_message
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| clip(&redact(s), 300))
                .unwrap_or_else(|| {
                    "Soniox reported that the transcription failed but gave no details.".to_string()
                }),
        },
        other => RemoteStatus::Error {
            error_type: Some("unknown_status".to_string()),
            message: if other.is_empty() {
                "Soniox returned a transcription without a status.".to_string()
            } else {
                format!(
                    "Soniox returned an unknown transcription status “{}”.",
                    clip(other, 40)
                )
            },
        },
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderErrorKind {
    /// No API key configured.
    NotConfigured,
    /// 401 / 403: key rejected.
    Auth,
    /// 402: balance or budget exhausted.
    Payment,
    /// 429: rate / capacity limit.
    RateLimited,
    /// 400 / 413 / 422: the request itself is wrong.
    InvalidRequest,
    NotFound,
    /// 409: invalid transcription state.
    Conflict,
    /// 5xx.
    Server,
    /// Connection problems.
    Network,
    Timeout,
    /// A response that could not be understood.
    InvalidResponse,
    /// The provider processed the job and reported a failure.
    Transcription,
    Cancelled,
    /// Local file problems (missing audio, disk errors).
    Io,
}

/// A normalised speech-provider failure with a user-facing, actionable message.
///
/// `retryable` means "trying the same call again without changing anything may
/// succeed" (transient). The job runner retries those automatically; the UI offers a
/// manual retry for them once the automatic attempts are exhausted.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProviderError {
    pub kind: ProviderErrorKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    pub message: String,
    pub retryable: bool,
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ProviderError {}

impl ProviderError {
    pub fn new(
        kind: ProviderErrorKind,
        message: impl Into<String>,
        retryable: bool,
    ) -> ProviderError {
        ProviderError {
            kind,
            status: None,
            message: message.into(),
            retryable,
        }
    }
    pub fn not_configured() -> ProviderError {
        ProviderError::new(
            ProviderErrorKind::NotConfigured,
            "Soniox is not configured. Set SONIOX_API_KEY in the server's .env file and restart, or start the server with --fixture to use labelled fixture transcripts.",
            false,
        )
    }
    pub fn cancelled() -> ProviderError {
        ProviderError::new(
            ProviderErrorKind::Cancelled,
            "Transcription was cancelled.",
            false,
        )
    }
    pub fn network(detail: &str) -> ProviderError {
        ProviderError::new(
            ProviderErrorKind::Network,
            format!("Could not reach Soniox ({}). Check the server's internet connection and try again.", clip(&redact(detail), 160)),
            true,
        )
    }
    pub fn timeout(what: &str) -> ProviderError {
        ProviderError::new(
            ProviderErrorKind::Timeout,
            format!("Soniox did not respond in time while {what}. Try again."),
            true,
        )
    }
    pub fn invalid_response(detail: &str) -> ProviderError {
        ProviderError::new(
            ProviderErrorKind::InvalidResponse,
            format!(
                "Soniox returned a response that could not be understood ({}).",
                clip(&redact(detail), 160)
            ),
            false,
        )
    }
    pub fn io(detail: &str) -> ProviderError {
        ProviderError::new(ProviderErrorKind::Io, clip(detail, 300), false)
    }
    pub fn is_cancelled(&self) -> bool {
        self.kind == ProviderErrorKind::Cancelled
    }
}

fn clip(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max).collect();
        out.push('…');
        out
    }
}

/// Remove anything that looks like a bearer credential from provider-supplied text.
fn redact(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(pos) = rest.to_ascii_lowercase().find("bearer ") {
        out.push_str(&rest[..pos]);
        out.push_str("Bearer [redacted]");
        let after = &rest[pos + 7..];
        let end = after
            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',')
            .unwrap_or(after.len());
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

fn strip_terminal_punct(s: &str) -> &str {
    s.trim().trim_end_matches(['.', '!', ' '])
}

/// Turn a non-2xx HTTP response into a [`ProviderError`]. The body is parsed as a
/// Soniox error object when possible; HTML or oversized bodies are never echoed.
pub fn classify_http_error(status: u16, body: &str) -> ProviderError {
    let parsed = serde_json::from_str::<SonioxErrorBody>(body)
        .ok()
        .filter(|b| {
            b.message.is_some() || b.error_type.is_some() || !b.validation_errors.is_empty()
        });
    let mut detail = String::new();
    if let Some(b) = &parsed {
        if let Some(m) = b
            .message
            .as_deref()
            .map(strip_terminal_punct)
            .filter(|m| !m.is_empty())
        {
            detail.push_str(m);
        } else if let Some(t) = b
            .error_type
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
        {
            detail.push_str(t);
        }
        let fields: Vec<String> = b
            .validation_errors
            .iter()
            .filter_map(|v| {
                let m = v
                    .message
                    .as_deref()
                    .map(strip_terminal_punct)
                    .filter(|m| !m.is_empty())?;
                Some(
                    match v
                        .location
                        .as_deref()
                        .map(str::trim)
                        .filter(|l| !l.is_empty())
                    {
                        Some(l) => format!("{l}: {m}"),
                        None => m.to_string(),
                    },
                )
            })
            .take(3)
            .collect();
        if !fields.is_empty() {
            if !detail.is_empty() {
                detail.push_str(" — ");
            }
            detail.push_str(&fields.join("; "));
        }
    } else {
        let t = body.trim();
        if !t.is_empty() && !t.starts_with('<') && !t.starts_with('{') && t.len() <= 200 {
            detail.push_str(strip_terminal_punct(t));
        }
    }
    let detail = clip(&redact(&detail), 300);
    let with = |prefix: &str, suffix: &str| -> String {
        if detail.is_empty() {
            format!("{prefix}. {suffix}").trim().to_string()
        } else {
            format!("{prefix}: {detail}. {suffix}").trim().to_string()
        }
    };
    use ProviderErrorKind as K;
    let (kind, retryable, message) = match status {
        401 | 403 => (K::Auth, false, "Soniox rejected the API key. Check SONIOX_API_KEY in the server's .env file and restart the server.".to_string()),
        402 => (K::Payment, false, "The Soniox account balance or budget is exhausted. Add credit in the Soniox console, then retry.".to_string()),
        404 => (K::NotFound, false, with("Soniox could not find the requested file or transcription", "It may already have been deleted; retry to start over.")),
        408 => (K::Timeout, true, "Soniox timed out handling the request. Try again.".to_string()),
        409 => (K::Conflict, false, with("Soniox reported an invalid transcription state", "Retry to start a fresh transcription.")),
        413 => (K::InvalidRequest, false, "The audio is too large for Soniox. Trim the media or split it into shorter files.".to_string()),
        400 | 422 => (K::InvalidRequest, false, with("Soniox rejected the request", "")),
        429 => (K::RateLimited, true, "Soniox is rate limiting requests or is at capacity. The transcription will be retried; if it keeps failing, wait a minute and retry.".to_string()),
        500..=599 => (K::Server, true, format!("Soniox had an internal problem (HTTP {status}). This is usually temporary — try again shortly.")),
        _ => (K::InvalidResponse, false, with(&format!("Soniox returned an unexpected response (HTTP {status})"), "")),
    };
    ProviderError {
        kind,
        status: Some(status),
        message,
        retryable,
    }
}

/// Normalise a provider-reported job failure (`status == "error"`).
pub fn transcription_failed(error_type: Option<&str>, message: &str) -> ProviderError {
    let et = error_type.unwrap_or("").to_ascii_lowercase();
    // Failures caused by the input itself will not go away by retrying.
    let permanent = [
        "invalid",
        "unsupported",
        "not_found",
        "too_long",
        "too_large",
        "too_short",
        "empty",
        "format",
        "unknown_status",
        "balance",
        "budget",
    ]
    .iter()
    .any(|k| et.contains(k));
    let m = strip_terminal_punct(message);
    let message = if m.is_empty() {
        "Soniox could not transcribe this media.".to_string()
    } else {
        format!(
            "Soniox could not transcribe this media: {}.",
            clip(&redact(m), 300)
        )
    };
    ProviderError {
        kind: ProviderErrorKind::Transcription,
        status: None,
        message,
        retryable: !permanent,
    }
}

// ---------------------------------------------------------------------------------
// tokens → words
// ---------------------------------------------------------------------------------

/// Scripts written without spaces between words: every token is its own word.
fn is_spaceless_script(c: char) -> bool {
    matches!(c as u32,
        0x0E00..=0x0EFF      // Thai, Lao
        | 0x1000..=0x109F    // Myanmar
        | 0x1780..=0x17FF    // Khmer
        | 0x3040..=0x30FF    // Hiragana, Katakana
        | 0x31F0..=0x31FF
        | 0x3400..=0x4DBF    // CJK ext. A
        | 0x4E00..=0x9FFF    // CJK unified
        | 0xF900..=0xFAFF
        | 0x20000..=0x2FFFF)
}

fn is_punctuation_only(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| !c.is_alphanumeric() && !c.is_whitespace())
}

fn is_special_marker(s: &str) -> bool {
    s.len() >= 3
        && s.starts_with('<')
        && s.ends_with('>')
        && s[1..s.len() - 1]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '/')
}

struct WordBuilder {
    text: String,
    start_ms: i64,
    end_ms: i64,
    speaker: Option<String>,
    language: Option<String>,
    conf_sum: f64,
    conf_n: u32,
    token_start: usize,
    token_end: usize,
    spaceless: bool,
}

/// Convert provider tokens into a word-level [`Transcript`].
///
/// * Every token is preserved verbatim in `Transcript.tokens`; words point back
///   into that vector via `token_start..token_end`.
/// * Translation tokens, special markers (`<end>`), audio-event tokens, tokens with
///   empty text and spoken tokens without timestamps do not produce words.
/// * A token with a leading space starts a new word; so does a speaker or language
///   change, and every token of a script written without spaces (CJK, Thai, …).
/// * Punctuation-only tokens are attached to the neighbouring word's display text
///   (trailing punctuation to the previous word, opening punctuation such as `¿` or
///   an opening quote to the next). They deliberately do **not** extend the word's
///   time range or affect its confidence: a word's `[start, end)` is the audio of the
///   spoken tokens only, which keeps transcript-driven cuts tight.
/// * Word times are clamped so `end >= start` and starts never decrease.
pub fn tokens_to_transcript(
    asset_id: &str,
    provider: &str,
    model: &str,
    fixture: bool,
    tokens: &[SonioxToken],
) -> Transcript {
    let raw: Vec<RawToken> = tokens
        .iter()
        .map(|t| RawToken {
            text: t.text.clone(),
            start_ms: t.start_ms,
            end_ms: t.end_ms,
            confidence: t.confidence,
            speaker: t.speaker.clone(),
            language: t.language.clone(),
        })
        .collect();

    let mut words: Vec<Word> = Vec::new();
    let mut speakers: Vec<String> = Vec::new();
    let mut languages: Vec<String> = Vec::new();
    let mut cur: Option<WordBuilder> = None;
    let mut pending_break = false; // previous token ended with whitespace
    let mut prefix = String::new(); // opening punctuation waiting for the next word
    let mut prefix_token: Option<usize> = None;
    let mut last_start = i64::MIN;

    fn flush(cur: &mut Option<WordBuilder>, words: &mut Vec<Word>, last_start: &mut i64) {
        if let Some(b) = cur.take() {
            let start = b.start_ms.max(*last_start).max(0);
            let end = b.end_ms.max(start);
            *last_start = start;
            words.push(Word {
                index: words.len() as u32,
                text: b.text,
                start: SourceTime::from_ms(start),
                end: SourceTime::from_ms(end),
                speaker: b.speaker,
                language: b.language,
                confidence: if b.conf_n > 0 {
                    Some(b.conf_sum / b.conf_n as f64)
                } else {
                    None
                },
                token_start: b.token_start as u32,
                token_end: b.token_end as u32,
            });
        }
    }

    for (i, tok) in tokens.iter().enumerate() {
        if tok
            .translation_status
            .as_deref()
            .is_some_and(|s| s.eq_ignore_ascii_case("translation"))
        {
            continue;
        }
        let trimmed = tok.text.trim();
        if trimmed.is_empty() {
            if !tok.text.is_empty() {
                pending_break = true;
            }
            continue;
        }
        if tok.is_audio_event == Some(true) || is_special_marker(trimmed) {
            pending_break = true;
            continue;
        }
        let leading_space = tok.text.starts_with(char::is_whitespace);
        let trailing_space = tok.text.ends_with(char::is_whitespace);
        let speaker = tok
            .speaker
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let language = tok
            .language
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        if is_punctuation_only(trimmed) {
            let speaker_changed = cur
                .as_ref()
                .is_some_and(|b| speaker.is_some() && b.speaker.is_some() && b.speaker != speaker);
            match cur.as_mut() {
                Some(b) if !leading_space && !pending_break && !speaker_changed => {
                    b.text.push_str(trimmed);
                    b.token_end = i + 1;
                }
                _ => {
                    prefix.push_str(trimmed);
                    prefix_token.get_or_insert(i);
                }
            }
            pending_break = trailing_space;
            continue;
        }

        let (Some(start_ms), Some(end_ms)) = (tok.start_ms, tok.end_ms) else {
            // spoken token without timing: cannot be placed on the timeline
            pending_break = pending_break || leading_space || trailing_space;
            continue;
        };
        let spaceless = trimmed.chars().any(is_spaceless_script);
        let starts_new = match &cur {
            None => true,
            Some(b) => {
                leading_space
                    || pending_break
                    || !prefix.is_empty()
                    || spaceless
                    || b.spaceless
                    || (speaker.is_some() && b.speaker.is_some() && b.speaker != speaker)
                    || (language.is_some() && b.language.is_some() && b.language != language)
            }
        };
        if starts_new {
            flush(&mut cur, &mut words, &mut last_start);
            let mut text = std::mem::take(&mut prefix);
            text.push_str(trimmed);
            cur = Some(WordBuilder {
                text,
                start_ms,
                end_ms,
                speaker: speaker.clone(),
                language: language.clone(),
                conf_sum: 0.0,
                conf_n: 0,
                token_start: prefix_token.take().unwrap_or(i),
                token_end: i + 1,
                spaceless,
            });
        } else if let Some(b) = cur.as_mut() {
            b.text.push_str(trimmed);
            b.end_ms = b.end_ms.max(end_ms);
            b.start_ms = b.start_ms.min(start_ms);
            b.token_end = i + 1;
            if b.speaker.is_none() {
                b.speaker = speaker.clone();
            }
            if b.language.is_none() {
                b.language = language.clone();
            }
        }
        if let (Some(b), Some(c)) = (cur.as_mut(), tok.confidence) {
            b.conf_sum += c.clamp(0.0, 1.0);
            b.conf_n += 1;
        }
        if let Some(s) = speaker {
            if !speakers.contains(&s) {
                speakers.push(s);
            }
        }
        if let Some(l) = language {
            if !languages.contains(&l) {
                languages.push(l);
            }
        }
        pending_break = trailing_space;
    }
    flush(&mut cur, &mut words, &mut last_start);
    // Opening punctuation with no following word belongs to the last word.
    if !prefix.is_empty() {
        if let Some(w) = words.last_mut() {
            w.text.push_str(&prefix);
            if let Some(pt) = prefix_token {
                w.token_end = w.token_end.max(pt as u32 + 1);
            }
        }
    }

    Transcript {
        asset_id: asset_id.to_string(),
        provider: provider.to_string(),
        model: model.to_string(),
        fixture,
        tokens: raw,
        words,
        speakers,
        languages,
    }
}

// ---------------------------------------------------------------------------------
// job state model
// ---------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    /// Waiting for a local worker slot; nothing has been sent to the provider yet.
    Queued,
    /// Audio is being uploaded to the provider's Files API.
    Uploading,
    /// The provider has the job (it may still be in the provider's own queue —
    /// see `TranscriptionStatus::message`).
    Processing,
    Completed,
    /// See `retryable` for whether trying again is expected to help.
    Failed,
    Cancelled,
}

/// Whether the provider-side file / transcription objects have been deleted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CleanupState {
    /// Nothing was ever created remotely.
    #[default]
    NotNeeded,
    /// Remote objects exist (the job is running or cleanup has not happened yet).
    Pending,
    Done,
    /// Deleting failed; the ids are kept so cleanup can be retried.
    Failed,
}

/// The persisted, user-visible state of one asset's transcription job.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TranscriptionStatus {
    pub state: JobState,
    /// Only meaningful for `Failed`: retrying unchanged may succeed.
    #[serde(default)]
    pub retryable: bool,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub error_kind: Option<ProviderErrorKind>,
    pub provider: String,
    pub model: String,
    /// True when produced by the fixture adapter (not real speech recognition).
    #[serde(default)]
    pub fixture: bool,
    /// Remote file id while it still exists remotely.
    #[serde(default)]
    pub file_id: Option<String>,
    /// Remote transcription id while it still exists remotely.
    #[serde(default)]
    pub transcription_id: Option<String>,
    #[serde(default)]
    pub cleanup: CleanupState,
    /// Number of automatic retries performed so far in this run.
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub word_count: Option<u32>,
    #[serde(default)]
    pub audio_duration_ms: Option<i64>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl TranscriptionStatus {
    pub fn queued(provider: &str, model: &str, fixture: bool, now_ms: i64) -> TranscriptionStatus {
        TranscriptionStatus {
            state: JobState::Queued,
            retryable: false,
            message: None,
            error_kind: None,
            provider: provider.to_string(),
            model: model.to_string(),
            fixture,
            file_id: None,
            transcription_id: None,
            cleanup: CleanupState::NotNeeded,
            attempts: 0,
            word_count: None,
            audio_duration_ms: None,
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
        }
    }

    /// A job is in flight (or waiting to be).
    pub fn is_active(&self) -> bool {
        matches!(
            self.state,
            JobState::Queued | JobState::Uploading | JobState::Processing
        )
    }

    pub fn is_terminal(&self) -> bool {
        !self.is_active()
    }

    pub fn can_cancel(&self) -> bool {
        self.is_active()
    }

    /// The user may ask for another attempt (any failed or cancelled job; whether it
    /// is *likely* to help is what `retryable` says).
    pub fn can_retry(&self) -> bool {
        matches!(self.state, JobState::Failed | JobState::Cancelled)
    }

    /// Remote objects are known to exist and still have to be deleted.
    pub fn has_remote_objects(&self) -> bool {
        self.file_id.is_some() || self.transcription_id.is_some()
    }

    /// A finished job whose remote objects still need deleting.
    pub fn needs_cleanup(&self) -> bool {
        self.is_terminal() && self.has_remote_objects()
    }

    /// Record a failure. Never downgrades a completed job.
    pub fn fail(&mut self, err: &ProviderError, now_ms: i64) {
        if err.is_cancelled() {
            self.cancel(now_ms);
            return;
        }
        self.state = JobState::Failed;
        self.retryable = err.retryable;
        self.error_kind = Some(err.kind);
        self.message = Some(err.message.clone());
        self.updated_at_ms = now_ms;
    }

    pub fn cancel(&mut self, now_ms: i64) {
        self.state = JobState::Cancelled;
        self.retryable = false;
        self.error_kind = Some(ProviderErrorKind::Cancelled);
        self.message = Some("Transcription was cancelled.".to_string());
        self.updated_at_ms = now_ms;
    }

    pub fn complete(&mut self, word_count: u32, now_ms: i64) {
        self.state = JobState::Completed;
        self.retryable = false;
        self.error_kind = None;
        self.word_count = Some(word_count);
        self.message = if word_count == 0 {
            Some("No speech detected in this media.".to_string())
        } else {
            None
        };
        self.updated_at_ms = now_ms;
    }

    /// Record the outcome of deleting the remote objects: pass what is still alive.
    pub fn record_cleanup(
        &mut self,
        file_left: Option<String>,
        transcription_left: Option<String>,
        attempted: bool,
        now_ms: i64,
    ) {
        self.file_id = file_left;
        self.transcription_id = transcription_left;
        self.cleanup = if self.has_remote_objects() {
            CleanupState::Failed
        } else if attempted || self.cleanup != CleanupState::NotNeeded {
            CleanupState::Done
        } else {
            CleanupState::NotNeeded
        };
        self.updated_at_ms = now_ms;
    }
}

/// May a new job be started for an asset whose current status is `current`?
/// Active jobs are never duplicated; a completed transcript is only redone on `force`.
pub fn can_start(current: &Option<TranscriptionStatus>, force: bool) -> bool {
    match current {
        None => true,
        Some(s) if s.is_active() => false,
        Some(s) if s.state == JobState::Completed => force,
        Some(_) => true,
    }
}

// ---------------------------------------------------------------------------------
// fixture data
// ---------------------------------------------------------------------------------

const FIXTURE_SENTENCES: &[&str] = &[
    "This is fixture speech for testing the editor.",
    "Um, every word here is synthetic, not real recognition.",
    "The second speaker, uh, replies with another deterministic sentence.",
    "You can select words, remove fillers, and generate captions.",
    "Um, transcript edits ripple through the timeline.",
    "Pauses like this one help test silence detection.",
    "Corrections never change the original, uh, source timestamps.",
    "Fixture data repeats until the media ends.",
];

struct Lcg(u64);

impl Lcg {
    fn seeded(seed: &str) -> Lcg {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for b in seed.bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
        Lcg(h | 1)
    }
    /// Uniform integer in `0..n`.
    fn below(&mut self, n: u64) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.0 >> 33) % n.max(1)
    }
}

/// Deterministic synthetic "speech" in Soniox token format, for fixture mode and
/// tests. The word sequence is fixed; `seed` only varies confidences and adds a few
/// milliseconds of timing jitter. No token ends after `duration_ms`.
pub fn fixture_tokens(duration_ms: i64, seed: &str) -> Vec<SonioxToken> {
    let mut rng = Lcg::seeded(seed);
    let mut out: Vec<SonioxToken> = Vec::new();
    let mut t: i64 = 300;
    let mut word_no: u64 = 0;
    let mut si = 0usize;
    'outer: loop {
        let sentence = FIXTURE_SENTENCES[si % FIXTURE_SENTENCES.len()];
        let speaker = if (si / 2) & 1 == 0 { "1" } else { "2" };
        for item in sentence.split_whitespace() {
            let word = item.trim_end_matches([',', '.', '!', '?']);
            let punct = &item[word.len()..];
            let len = word.chars().count() as i64;
            let dur = 90 + 45 * len + rng.below(24) as i64;
            if t + dur > duration_ms {
                break 'outer;
            }
            let is_filler = matches!(word.to_ascii_lowercase().as_str(), "um" | "uh");
            let base_conf = if is_filler {
                0.60 + rng.below(15) as f64 / 100.0
            } else if word_no % 9 == 7 {
                0.42 + rng.below(18) as f64 / 100.0
            } else {
                0.86 + rng.below(13) as f64 / 100.0
            };
            // sub-word pieces of up to three characters for longer words
            let chars: Vec<char> = word.chars().collect();
            let pieces: Vec<String> = if chars.len() <= 4 {
                vec![word.to_string()]
            } else {
                chars.chunks(3).map(|c| c.iter().collect()).collect()
            };
            let n = pieces.len() as i64;
            for (k, piece) in pieces.iter().enumerate() {
                let k = k as i64;
                let text = if k == 0 && !out.is_empty() {
                    format!(" {piece}")
                } else {
                    piece.clone()
                };
                out.push(SonioxToken {
                    text,
                    start_ms: Some(t + dur * k / n),
                    end_ms: Some(t + dur * (k + 1) / n),
                    confidence: Some(
                        ((base_conf - 0.01 * k as f64).clamp(0.05, 0.99) * 100.0).round() / 100.0,
                    ),
                    speaker: Some(speaker.to_string()),
                    language: Some("en".to_string()),
                    translation_status: None,
                    is_audio_event: None,
                });
            }
            t += dur;
            if !punct.is_empty() {
                out.push(SonioxToken {
                    text: punct.to_string(),
                    start_ms: Some(t),
                    end_ms: Some(t),
                    confidence: Some(0.97),
                    speaker: Some(speaker.to_string()),
                    language: Some("en".to_string()),
                    translation_status: None,
                    is_audio_event: None,
                });
            }
            t += 50 + rng.below(30) as i64;
            if punct == "," {
                t += 120;
            } else if !punct.is_empty() {
                t += 280;
            }
            word_no += 1;
        }
        // a couple of long pauses per cycle for silence detection
        if matches!(si % FIXTURE_SENTENCES.len(), 2 | 5) {
            t += 1300 + rng.below(200) as i64;
        }
        si += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_bearer_tokens() {
        assert_eq!(
            redact("header Bearer abc123 rejected"),
            "header Bearer [redacted] rejected"
        );
        assert_eq!(redact("nothing here"), "nothing here");
    }

    #[test]
    fn start_rules() {
        assert!(can_start(&None, false));
        let mut s = TranscriptionStatus::queued("soniox", DEFAULT_MODEL, false, 1);
        assert!(!can_start(&Some(s.clone()), true));
        s.complete(3, 2);
        assert!(!can_start(&Some(s.clone()), false));
        assert!(can_start(&Some(s.clone()), true));
        s.fail(&ProviderError::timeout("polling"), 3);
        assert!(can_start(&Some(s), false));
    }
}
