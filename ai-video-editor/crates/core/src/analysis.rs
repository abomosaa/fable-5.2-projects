//! Speech analysis helpers: filler-word detection and silence detection.

use crate::mapping::clip_audible;
use crate::model::*;
use crate::time::{ms_to_ticks, SourceTime, TimelineTime, TICKS_PER_SECOND};
use crate::transcript::Transcript;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;

/// Hesitation sounds treated as filler words (matched case-insensitively after
/// stripping punctuation). Deliberately conservative: real words such as "like" or
/// "so" are *not* included because removing them changes meaning.
const FILLERS: &[&str] = &[
    "um", "umm", "ummm", "uh", "uhh", "uhm", "uhhh", "er", "err", "erm", "ah", "ahh", "eh", "hm",
    "hmm", "hmmm", "mm", "mmm", "mhm", "em", "ehm", "äh", "ähm", "öh", "euh", "eeh", "este", "ehh",
];

/// Normalise a word for comparison: lowercase, strip surrounding punctuation.
pub fn normalize_word(text: &str) -> String {
    text.trim()
        .trim_matches(|c: char| !c.is_alphanumeric())
        .to_lowercase()
}

pub fn is_filler(text: &str) -> bool {
    let n = normalize_word(text);
    !n.is_empty() && FILLERS.contains(&n.as_str())
}

/// Audio peak envelope of an asset: one unsigned 16-bit peak (max |sample|) per window.
#[derive(Clone, Debug, PartialEq)]
pub struct Waveform {
    pub peaks_per_second: u32,
    pub peaks: Vec<u16>,
}

impl Waveform {
    /// Decode the on-disk / on-wire format: `"CWF1"`, u32 LE peaks-per-second,
    /// u32 LE count, then `count` u16 LE peaks.
    pub fn from_bytes(b: &[u8]) -> Option<Waveform> {
        if b.len() < 12 || &b[0..4] != b"CWF1" {
            return None;
        }
        let pps = u32::from_le_bytes(b[4..8].try_into().ok()?);
        let n = u32::from_le_bytes(b[8..12].try_into().ok()?) as usize;
        if pps == 0 || b.len() < 12 + n * 2 {
            return None;
        }
        let peaks = b[12..12 + n * 2]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        Some(Waveform {
            peaks_per_second: pps,
            peaks,
        })
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(12 + self.peaks.len() * 2);
        out.extend_from_slice(b"CWF1");
        out.extend_from_slice(&self.peaks_per_second.to_le_bytes());
        out.extend_from_slice(&(self.peaks.len() as u32).to_le_bytes());
        for p in &self.peaks {
            out.extend_from_slice(&p.to_le_bytes());
        }
        out
    }

    /// Build from mono signed 16-bit PCM.
    pub fn from_pcm_s16(samples: &[i16], sample_rate: u32, peaks_per_second: u32) -> Waveform {
        let window = (sample_rate / peaks_per_second).max(1) as usize;
        let peaks = samples
            .chunks(window)
            .map(|w| {
                w.iter()
                    .map(|s| s.unsigned_abs())
                    .max()
                    .unwrap_or(0)
                    .min(32767)
                    * 2
            })
            .collect();
        Waveform {
            peaks_per_second,
            peaks,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SilenceOptions {
    /// Peaks below this level (dBFS) count as silence.
    pub threshold_db: f64,
    /// Only pauses at least this long are reported.
    pub min_duration_ms: i64,
    /// Breathing room kept on each side of a removed pause.
    pub padding_ms: i64,
}

impl Default for SilenceOptions {
    fn default() -> Self {
        SilenceOptions {
            threshold_db: -38.0,
            min_duration_ms: 700,
            padding_ms: 120,
        }
    }
}

impl SilenceOptions {
    pub fn sanitized(self) -> SilenceOptions {
        SilenceOptions {
            threshold_db: if self.threshold_db.is_finite() {
                self.threshold_db.clamp(-80.0, -6.0)
            } else {
                -38.0
            },
            min_duration_ms: self.min_duration_ms.clamp(100, 60_000),
            padding_ms: self.padding_ms.clamp(0, 2_000),
        }
    }
}

/// Raw silent stretches of a waveform, in source time (no padding applied).
pub fn detect_silences(
    w: &Waveform,
    threshold_db: f64,
    min_duration_ms: i64,
) -> Vec<(SourceTime, SourceTime)> {
    let threshold = (10f64.powf(threshold_db / 20.0) * 65535.0)
        .round()
        .clamp(0.0, 65535.0) as u16;
    let pps = w.peaks_per_second as i64;
    let to_time = |i: usize| SourceTime(i as i64 * TICKS_PER_SECOND / pps);
    let min = ms_to_ticks(min_duration_ms);
    let mut out = Vec::new();
    let mut run_start: Option<usize> = None;
    for (i, &p) in w.peaks.iter().enumerate() {
        if p <= threshold {
            run_start.get_or_insert(i);
        } else if let Some(s) = run_start.take() {
            if to_time(i) - to_time(s) >= min {
                out.push((to_time(s), to_time(i)));
            }
        }
    }
    if let Some(s) = run_start {
        let e = w.peaks.len();
        if to_time(e) - to_time(s) >= min {
            out.push((to_time(s), to_time(e)));
        }
    }
    out
}

/// A removable pause on the timeline.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SilenceCandidate {
    pub clip_id: ClipId,
    pub asset_id: AssetId,
    pub source_start: SourceTime,
    pub source_end: SourceTime,
    pub start: TimelineTime,
    pub end: TimelineTime,
}

/// Pauses in the audible audio of the current edit. Detection is audio based
/// (waveform peaks); when a transcript exists, spoken words are protected so a
/// quietly spoken word is never cut.
pub fn timeline_silences(
    p: &Project,
    waveforms: &BTreeMap<AssetId, Arc<Waveform>>,
    transcripts: &BTreeMap<AssetId, Arc<Transcript>>,
    opts: SilenceOptions,
) -> Vec<SilenceCandidate> {
    let opts = opts.sanitized();
    let pad = ms_to_ticks(opts.padding_ms);
    let min = ms_to_ticks(opts.min_duration_ms);
    let frame = p.fps().frame_ticks();
    let mut raw_cache: BTreeMap<&str, Vec<(SourceTime, SourceTime)>> = BTreeMap::new();
    let mut out = Vec::new();
    let mut clips: Vec<&Clip> = p.clips.values().filter(|c| clip_audible(p, c)).collect();
    clips.sort_by_key(|c| (c.start, c.id.clone()));
    for c in clips {
        let Some(asset_id) = c.asset_id() else {
            continue;
        };
        let Some(w) = waveforms.get(asset_id) else {
            continue;
        };
        let raw = raw_cache.entry(asset_id).or_insert_with(|| {
            detect_silences(w, opts.threshold_db, opts.min_duration_ms.min(200))
        });
        let (c_in, c_out) = (c.source_in, c.source_out());
        for &(s, e) in raw.iter() {
            // intersect with the clip, then carve out spoken words
            let (s, e) = (s.max(c_in), e.min(c_out));
            if e <= s {
                continue;
            }
            let mut pieces = vec![(s, e)];
            if let Some(t) = transcripts.get(asset_id) {
                let lo = t.words.partition_point(|w| w.end <= s);
                for word in t.words[lo..].iter().take_while(|w| w.start < e) {
                    let mut next = Vec::with_capacity(pieces.len() + 1);
                    for (ps, pe) in pieces {
                        if word.end <= ps || word.start >= pe {
                            next.push((ps, pe));
                            continue;
                        }
                        if word.start > ps {
                            next.push((ps, word.start));
                        }
                        if word.end < pe {
                            next.push((word.end, pe));
                        }
                    }
                    pieces = next;
                }
            }
            for (ps, pe) in pieces {
                // keep breathing room, except at the clip edges where there is nothing to protect
                let ps2 = if ps > c_in { ps + pad } else { ps };
                let pe2 = if pe < c_out { pe - pad } else { pe };
                if pe2 - ps2 < min {
                    continue;
                }
                let start = c.timeline_time_of(ps2).max(c.start);
                let end = c.timeline_time_of(pe2).min(c.end());
                if end - start < 2 * frame {
                    continue;
                }
                out.push(SilenceCandidate {
                    clip_id: c.id.clone(),
                    asset_id: asset_id.to_string(),
                    source_start: ps2,
                    source_end: pe2,
                    start,
                    end,
                });
            }
        }
    }
    out.sort_by_key(|s| (s.start, s.clip_id.clone()));
    out
}
