//! Caption generation from the timeline transcript.

use crate::commands::CueDraft;
use crate::error::{CmdResult, CommandError};
use crate::mapping::{speaker_name, timeline_transcript, TimelineWord};
use crate::model::*;
use crate::time::{ms_to_ticks, TimelineTime};
use crate::transcript::Transcript;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct CaptionOptions {
    pub max_chars_per_line: u32,
    pub max_lines: u32,
    /// A caption never stays on screen longer than this.
    pub max_duration_ms: i64,
    /// A pause at least this long starts a new caption.
    pub pause_break_ms: i64,
    /// Prefix the first caption of each speaker turn with the speaker name.
    pub speaker_labels: bool,
    /// Leave filler words (um, uh …) out of the captions.
    pub skip_fillers: bool,
}

impl Default for CaptionOptions {
    fn default() -> Self {
        CaptionOptions {
            max_chars_per_line: 36,
            max_lines: 2,
            max_duration_ms: 5000,
            pause_break_ms: 800,
            speaker_labels: false,
            skip_fillers: true,
        }
    }
}

impl CaptionOptions {
    pub fn validate(&self) -> CmdResult<()> {
        if !(8..=80).contains(&self.max_chars_per_line) {
            return Err(CommandError::invalid(
                "options.max_chars_per_line",
                "Characters per line must be between 8 and 80",
            ));
        }
        if !(1..=4).contains(&self.max_lines) {
            return Err(CommandError::invalid(
                "options.max_lines",
                "Lines per caption must be between 1 and 4",
            ));
        }
        if !(500..=20_000).contains(&self.max_duration_ms) {
            return Err(CommandError::invalid(
                "options.max_duration_ms",
                "Maximum caption duration must be between 0.5 and 20 seconds",
            ));
        }
        if !(100..=10_000).contains(&self.pause_break_ms) {
            return Err(CommandError::invalid(
                "options.pause_break_ms",
                "Pause break must be between 0.1 and 10 seconds",
            ));
        }
        Ok(())
    }
}

/// Greedy word wrap. Returns `None` when the words do not fit in `max_lines` lines.
pub fn wrap_lines(words: &[&str], max_chars: usize, max_lines: usize) -> Option<Vec<String>> {
    let mut lines: Vec<String> = Vec::new();
    let mut cur = String::new();
    for w in words {
        let wl = w.chars().count();
        let cl = cur.chars().count();
        if cur.is_empty() {
            cur.push_str(w);
        } else if cl + 1 + wl <= max_chars {
            cur.push(' ');
            cur.push_str(w);
        } else {
            lines.push(std::mem::take(&mut cur));
            cur.push_str(w);
        }
    }
    if !cur.is_empty() {
        lines.push(cur);
    }
    if lines.len() > max_lines {
        return None;
    }
    Some(lines)
}

fn ends_sentence(text: &str) -> bool {
    text.trim_end_matches(['"', '\'', ')', '”', '’'])
        .ends_with(['.', '!', '?', '。', '！', '？', '…'])
}

/// Build caption cues (timeline time) from what is currently audible.
pub fn generate_cues(
    p: &Project,
    transcripts: &BTreeMap<AssetId, Arc<Transcript>>,
    opts: &CaptionOptions,
) -> Vec<CueDraft> {
    let view = timeline_transcript(p, transcripts);
    let fps = p.fps();
    let frame = fps.frame_ticks();
    let max_chars = opts.max_chars_per_line as usize;
    let max_lines = opts.max_lines as usize;
    let max_dur = ms_to_ticks(opts.max_duration_ms);
    let pause = ms_to_ticks(opts.pause_break_ms);
    let mut cues: Vec<CueDraft> = Vec::new();
    let mut last_speaker: Option<(String, String)> = None; // (asset, speaker) of the previous cue

    for seg in &view.segments {
        let words: Vec<&TimelineWord> = seg
            .words
            .iter()
            .filter(|w| !w.text.trim().is_empty())
            .filter(|w| !(opts.skip_fillers && w.filler))
            .collect();
        let mut i = 0;
        while i < words.len() {
            // grow a cue starting at word i
            let first = words[i];
            let speaker = first.speaker.clone();
            let label = match (&speaker, opts.speaker_labels) {
                (Some(s), true)
                    if last_speaker.as_ref() != Some(&(seg.asset_id.clone(), s.clone())) =>
                {
                    Some(format!("{}:", speaker_name(p, &seg.asset_id, s)))
                }
                _ => None,
            };
            let mut texts: Vec<&str> = Vec::new();
            if let Some(l) = &label {
                texts.push(l.as_str());
            }
            let mut j = i;
            while j < words.len() {
                let w = words[j];
                if j > i {
                    let prev = words[j - 1];
                    if w.speaker != speaker
                        || w.start - prev.end >= pause
                        || w.end - first.start > max_dur
                    {
                        break;
                    }
                }
                texts.push(w.text.as_str());
                if wrap_lines(&texts, max_chars, max_lines).is_none() && j > i {
                    texts.pop();
                    break;
                }
                j += 1;
                // prefer to end on a sentence boundary once the cue is reasonably full
                let used: usize = texts.iter().map(|t| t.chars().count() + 1).sum();
                if ends_sentence(&w.text) && used * 2 >= max_chars * max_lines {
                    break;
                }
            }
            let last = words[j - 1];
            let lines =
                wrap_lines(&texts, max_chars, max_lines).unwrap_or_else(|| vec![texts.join(" ")]);
            let start = TimelineTime(fps.snap_floor(first.start.0));
            let mut end = TimelineTime(fps.snap_ceil(last.end.0)).min(seg.end);
            if end.0 - start.0 < frame {
                end = start + frame;
            }
            cues.push(CueDraft {
                start,
                duration: end - start,
                text: lines.join("\n"),
                speaker: speaker.as_ref().map(|s| speaker_name(p, &seg.asset_id, s)),
                source: Some(CaptionSource {
                    asset_id: seg.asset_id.clone(),
                    word_start: first.index,
                    word_end: last.index + 1,
                }),
            });
            if let Some(s) = speaker {
                last_speaker = Some((seg.asset_id.clone(), s));
            }
            i = j;
        }
    }
    // Overlapping speech on several tracks: keep cues ordered and non-overlapping.
    cues.sort_by_key(|c| (c.start, c.duration));
    let mut out: Vec<CueDraft> = Vec::with_capacity(cues.len());
    for mut c in cues {
        if let Some(prev) = out.last_mut() {
            let prev_end = prev.start + prev.duration;
            if c.start < prev_end {
                if c.start - prev.start >= 6 * frame {
                    prev.duration = c.start - prev.start;
                } else {
                    // nearly simultaneous: push the later cue behind the earlier one
                    let end = c.start + c.duration;
                    c.start = prev_end;
                    // never drop spoken words: a cue squeezed out completely still
                    // gets one frame (later cues queue up behind it the same way)
                    c.duration = (end - prev_end).max(frame);
                }
            }
        }
        out.push(c);
    }
    out
}
