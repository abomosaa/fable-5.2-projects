//! Transcript data model.
//!
//! A [`Transcript`] belongs to one *asset* and is expressed purely in **source time**.
//! It is immutable once produced: the provider's raw tokens are preserved verbatim in
//! `tokens`, and `words` is a normalised word-level view that points back into them.
//! User corrections never touch this structure — they live in the project document
//! (`Project::transcript.corrections`) as an overlay keyed by word index.

use crate::model::AssetId;
use crate::time::SourceTime;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;

/// A provider token exactly as returned (Soniox: sub-word pieces with a leading space
/// marking word starts).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RawToken {
    pub text: String,
    #[serde(default)]
    pub start_ms: Option<i64>,
    #[serde(default)]
    pub end_ms: Option<i64>,
    #[serde(default)]
    pub confidence: Option<f64>,
    #[serde(default)]
    pub speaker: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
}

/// One spoken word (tokens merged), with trailing punctuation attached.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Word {
    /// Stable index of the word inside its transcript.
    pub index: u32,
    /// Display text including attached punctuation, e.g. `"Hello,"`.
    pub text: String,
    pub start: SourceTime,
    pub end: SourceTime,
    #[serde(default)]
    pub speaker: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    /// Mean confidence of the word's tokens (punctuation excluded), when reported.
    #[serde(default)]
    pub confidence: Option<f64>,
    /// Range of raw tokens `[token_start, token_end)` this word was built from.
    pub token_start: u32,
    pub token_end: u32,
}

impl Word {
    #[inline]
    pub fn midpoint(&self) -> SourceTime {
        SourceTime((self.start.0 + self.end.0) / 2)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Transcript {
    pub asset_id: AssetId,
    /// `"soniox"` or `"fixture"`.
    pub provider: String,
    pub model: String,
    /// True when the data is deterministic fixture data, not real speech recognition.
    #[serde(default)]
    pub fixture: bool,
    /// Original provider tokens, untouched.
    pub tokens: Vec<RawToken>,
    pub words: Vec<Word>,
    /// Distinct speaker ids in order of first appearance.
    #[serde(default)]
    pub speakers: Vec<String>,
    /// Distinct language codes in order of first appearance.
    #[serde(default)]
    pub languages: Vec<String>,
}

impl Transcript {
    /// Indices `[lo, hi)` of words whose midpoint lies in `[start, end)`.
    /// Midpoint ownership guarantees that a word belongs to exactly one side of a cut.
    pub fn word_range(&self, start: SourceTime, end: SourceTime) -> (usize, usize) {
        let lo = self.words.partition_point(|w| w.midpoint() < start);
        let hi = self.words.partition_point(|w| w.midpoint() < end);
        (lo, hi.max(lo))
    }
}

/// Read-only inputs a command may consult besides the project document.
#[derive(Clone, Default)]
pub struct Env {
    pub transcripts: BTreeMap<AssetId, Arc<Transcript>>,
    /// Parsed cues of imported subtitle assets.
    pub subtitles: BTreeMap<AssetId, Arc<Vec<SubtitleCue>>>,
}

/// A cue from an imported subtitle file (source time == file time).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SubtitleCue {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}
