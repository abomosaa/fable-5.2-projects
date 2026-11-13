//! Transcript ⇄ timeline mapping.
//!
//! Transcripts live in *source* time. What the user reads and edits is the
//! **timeline transcript**: the words that are actually audible in the current edit,
//! in output order, each carrying its exact timeline time. It is derived — never
//! stored — from the project document and the immutable per-asset transcripts, so it
//! is always consistent with cuts, trims, speed changes and removed ranges.

use crate::analysis::is_filler;
use crate::model::*;
use crate::time::{SourceTime, Speed, TimelineTime};
use crate::transcript::Transcript;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;

/// A transcript word placed on the output timeline.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TimelineWord {
    /// Index of the word in its asset transcript.
    pub index: u32,
    pub start: TimelineTime,
    pub end: TimelineTime,
    pub source_start: SourceTime,
    pub source_end: SourceTime,
    /// Display text (the user's correction when present).
    pub text: String,
    /// The provider's original text, present only when `text` is a correction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub filler: bool,
}

/// Source media that was cut out immediately before a segment (the clip to the left
/// shows the same asset up to `source_start`, this one resumes at `source_end`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RemovedGap {
    /// Clips whose right-hand cut can be healed to restore the gap (`HealCuts`).
    pub heal_clip_ids: Vec<ClipId>,
    pub source_start: SourceTime,
    pub source_end: SourceTime,
    /// The words that were removed, for display.
    pub text: String,
    pub word_count: u32,
    /// Why it was removed, when the audit trail knows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<RemovalReason>,
}

/// The words of one audible audio clip.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Segment {
    pub clip_id: ClipId,
    pub asset_id: AssetId,
    pub track_id: TrackId,
    pub start: TimelineTime,
    pub end: TimelineTime,
    pub source_start: SourceTime,
    pub source_end: SourceTime,
    pub speed: Speed,
    pub fixture: bool,
    pub words: Vec<TimelineWord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed_before: Option<RemovedGap>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TranscriptView {
    pub revision: u64,
    pub segments: Vec<Segment>,
    /// Audible assets on the timeline that have no completed transcript.
    pub untranscribed_assets: Vec<AssetId>,
    pub word_count: u32,
    pub filler_count: u32,
    pub corrected_count: u32,
    pub removed_count: u32,
}

/// Is this clip's sound part of the output?
pub fn clip_audible(p: &Project, c: &Clip) -> bool {
    matches!(c.content, ClipContent::Audio { .. })
        && c.enabled
        && p.track(&c.track_id).is_some_and(|t| p.track_active(t))
}

/// Display name of a speaker for an asset.
pub fn speaker_name(p: &Project, asset_id: &str, speaker: &str) -> String {
    p.transcript
        .speaker_names
        .get(asset_id)
        .and_then(|m| m.get(speaker))
        .cloned()
        .unwrap_or_else(|| format!("Speaker {speaker}"))
}

/// Map one clip's words onto the timeline (midpoint ownership, clamped to the clip).
pub fn clip_words(p: &Project, c: &Clip, t: &Transcript) -> Vec<TimelineWord> {
    let (lo, hi) = t.word_range(c.source_in, c.source_out());
    let corrections = c.asset_id().and_then(|a| p.transcript.corrections.get(a));
    t.words[lo..hi]
        .iter()
        .map(|w| {
            let start = c.timeline_time_of(w.start).max(c.start).min(c.end());
            let end = c.timeline_time_of(w.end).max(start).min(c.end());
            let corrected = corrections
                .and_then(|m| m.get(&w.index))
                .filter(|t| **t != w.text);
            TimelineWord {
                index: w.index,
                start,
                end,
                source_start: w.start,
                source_end: w.end,
                text: corrected.cloned().unwrap_or_else(|| w.text.clone()),
                original: corrected.map(|_| w.text.clone()),
                speaker: w.speaker.clone(),
                language: w.language.clone(),
                confidence: w.confidence,
                filler: is_filler(&w.text),
            }
        })
        .collect()
}

/// Build the timeline transcript for the current edit.
pub fn timeline_transcript(
    p: &Project,
    transcripts: &BTreeMap<AssetId, Arc<Transcript>>,
) -> TranscriptView {
    let track_pos: BTreeMap<&str, usize> = p
        .tracks
        .iter()
        .enumerate()
        .map(|(i, t)| (t.id.as_str(), i))
        .collect();
    let mut audible: Vec<&Clip> = p.clips.values().filter(|c| clip_audible(p, c)).collect();
    audible.sort_by_key(|c| {
        (
            c.start,
            track_pos.get(c.track_id.as_str()).copied().unwrap_or(0),
            c.id.clone(),
        )
    });

    // clips by (track, start) to find the left neighbour of a clip quickly
    let mut by_track_end: BTreeMap<(&str, TimelineTime), &Clip> = BTreeMap::new();
    let mut by_track_start: BTreeMap<(&str, TimelineTime), &Clip> = BTreeMap::new();
    for c in p.clips.values() {
        by_track_end.insert((c.track_id.as_str(), c.end()), c);
        by_track_start.insert((c.track_id.as_str(), c.start), c);
    }

    let mut view = TranscriptView {
        revision: p.revision,
        ..Default::default()
    };
    let mut missing: Vec<AssetId> = Vec::new();
    for c in audible {
        let Some(asset_id) = c.asset_id() else {
            continue;
        };
        let Some(t) = transcripts.get(asset_id) else {
            if !missing.iter().any(|m| m == asset_id) {
                missing.push(asset_id.to_string());
            }
            continue;
        };
        let words = clip_words(p, c, t);
        // Was source media removed right before this clip?
        let mut removed_before = None;
        if let Some(prev) = by_track_end.get(&(c.track_id.as_str(), c.start)) {
            if healable(prev, c) {
                let (lo, hi) = t.word_range(prev.source_out(), c.source_in);
                let text = t.words[lo..hi]
                    .iter()
                    .map(|w| w.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" ");
                let mut heal = vec![prev.id.clone()];
                if let Some(link) = &prev.link_id {
                    for other in p.clips.values() {
                        if other.id != prev.id
                            && other.link_id.as_ref() == Some(link)
                            && other.end() == prev.end()
                        {
                            if let Some(next) =
                                by_track_start.get(&(other.track_id.as_str(), other.end()))
                            {
                                if healable(other, next) {
                                    heal.push(other.id.clone());
                                }
                            }
                        }
                    }
                }
                let (gs, ge) = (prev.source_out(), c.source_in);
                let reason = p
                    .transcript
                    .removals
                    .iter()
                    .rev()
                    .find(|r| r.asset_id == asset_id && r.source_start < ge && r.source_end > gs)
                    .map(|r| r.reason);
                view.removed_count += (hi - lo) as u32;
                removed_before = Some(RemovedGap {
                    heal_clip_ids: heal,
                    source_start: gs,
                    source_end: ge,
                    text,
                    word_count: (hi - lo) as u32,
                    reason,
                });
            }
        }
        view.word_count += words.len() as u32;
        view.filler_count += words.iter().filter(|w| w.filler).count() as u32;
        view.corrected_count += words.iter().filter(|w| w.original.is_some()).count() as u32;
        view.segments.push(Segment {
            clip_id: c.id.clone(),
            asset_id: asset_id.to_string(),
            track_id: c.track_id.clone(),
            start: c.start,
            end: c.end(),
            source_start: c.source_in,
            source_end: c.source_out(),
            speed: c.speed,
            fixture: t.fixture,
            words,
            removed_before,
        });
    }
    view.untranscribed_assets = missing;
    view
}

/// `left` and `right` touch on one track, show the same asset at the same speed, and
/// `right` resumes later in the source than `left` stops: media was cut out between.
pub fn healable(left: &Clip, right: &Clip) -> bool {
    left.content.is_timed_media()
        && left.track_id == right.track_id
        && left.end() == right.start
        && std::mem::discriminant(&left.content) == std::mem::discriminant(&right.content)
        && left.asset_id() == right.asset_id()
        && left.speed == right.speed
        && right.source_in > left.source_out()
}

/// All timeline positions at which a source instant of an asset is shown
/// (one per clip that covers it). Useful for "jump to this source moment".
pub fn source_to_timeline(
    p: &Project,
    asset_id: &str,
    s: SourceTime,
) -> Vec<(ClipId, TimelineTime)> {
    let mut v: Vec<(ClipId, TimelineTime)> = p
        .clips
        .values()
        .filter(|c| {
            c.asset_id() == Some(asset_id)
                && c.content.is_timed_media()
                && s >= c.source_in
                && s < c.source_out()
        })
        .map(|c| (c.id.clone(), c.timeline_time_of(s)))
        .collect();
    v.sort_by_key(|x| (x.1, x.0.clone()));
    v
}
