//! Typed, validated, atomic editing commands.
//!
//! [`apply`] never mutates its input. It works on a private copy, normalises and
//! validates the result, and only then returns the new document — so a rejected
//! command (any `Err`) leaves the project exactly as it was.

use crate::captions::{self, CaptionOptions};
use crate::error::{CmdResult, CommandError, ErrorCode};
use crate::model::*;
use crate::time::{FrameRate, SourceTime, Speed, Ticks, TimelineTime};
use crate::transcript::Env;
use crate::validate;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PlaceMode {
    /// Replace whatever is under the placed clips.
    #[default]
    Overwrite,
    /// Push later material to the right (ripple) to make room.
    Insert,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Edge {
    Start,
    End,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClipMove {
    pub clip_id: ClipId,
    pub start: TimelineTime,
    pub track_id: TrackId,
}

/// A span of *source* media, addressed through one timeline clip that shows it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceCut {
    pub clip_id: ClipId,
    pub source_start: SourceTime,
    pub source_end: SourceTime,
    /// Spoken text being removed (kept in the audit trail).
    #[serde(default)]
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceRange {
    pub start: SourceTime,
    pub end: SourceTime,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CueDraft {
    pub start: TimelineTime,
    pub duration: Ticks,
    pub text: String,
    #[serde(default)]
    pub speaker: Option<String>,
    #[serde(default)]
    pub source: Option<CaptionSource>,
}

/// A clip description used by paste / duplicate. `offset` is relative to the paste
/// anchor; `link_key` / `group_key` are remapped to fresh ids.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClipDraft {
    pub track_id: TrackId,
    pub offset: Ticks,
    pub duration: Ticks,
    #[serde(default)]
    pub source_in: SourceTime,
    #[serde(default)]
    pub speed: Speed,
    pub content: ClipContent,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub transform: Transform,
    #[serde(default)]
    pub color: ColorAdjust,
    #[serde(default)]
    pub gain_db: f64,
    #[serde(default)]
    pub fade_in: Ticks,
    #[serde(default)]
    pub fade_out: Ticks,
    #[serde(default)]
    pub link_key: Option<String>,
    #[serde(default)]
    pub group_key: Option<String>,
}

fn yes() -> bool {
    true
}

fn double_option<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// Partial update of clip properties; only present fields change.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct ClipPatch {
    // transform
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotation: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crop_left: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crop_top: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crop_right: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crop_bottom: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flip_h: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flip_v: Option<bool>,
    // colour
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brightness: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contrast: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saturation: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    // audio
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gain_db: Option<f64>,
    // common
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fade_in: Option<Ticks>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fade_out: Option<Ticks>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    // text / caption
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align: Option<TextAlign>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub background: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outline_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outline_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow: Option<bool>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub speaker: Option<Option<String>>,
}

/// Every mutation of a project document.
// The variants differ a lot in size, but commands are short-lived values that are
// parsed once and applied once; boxing fields would only complicate the wire types.
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    // ---- project -------------------------------------------------------------
    UpdateSettings {
        #[serde(default)]
        width: Option<u32>,
        #[serde(default)]
        height: Option<u32>,
        #[serde(default)]
        fps: Option<FrameRate>,
        #[serde(default)]
        background: Option<String>,
        #[serde(default)]
        caption_style: Option<CaptionStyle>,
    },
    // ---- tracks --------------------------------------------------------------
    AddTrack {
        kind: TrackKind,
        #[serde(default)]
        name: Option<String>,
    },
    RemoveTrack {
        track_id: TrackId,
    },
    UpdateTrack {
        track_id: TrackId,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        muted: Option<bool>,
        #[serde(default)]
        solo: Option<bool>,
        #[serde(default)]
        locked: Option<bool>,
        #[serde(default)]
        hidden: Option<bool>,
        #[serde(default)]
        gain_db: Option<f64>,
    },
    /// Move a track to a new position among the tracks of its kind
    /// (`ordinal` 0 == V1 / A1).
    MoveTrack {
        track_id: TrackId,
        ordinal: usize,
    },
    // ---- adding clips --------------------------------------------------------
    /// Place an asset on the timeline. Video assets with sound produce a linked
    /// video + audio clip pair.
    AddAssetClips {
        asset_id: AssetId,
        /// `None` appends after the last clip of the target tracks.
        #[serde(default)]
        start: Option<TimelineTime>,
        #[serde(default)]
        track_id: Option<TrackId>,
        #[serde(default)]
        source_in: Option<SourceTime>,
        #[serde(default)]
        source_out: Option<SourceTime>,
        #[serde(default)]
        mode: PlaceMode,
    },
    /// Rough cut: append the given source ranges of one asset as consecutive clips.
    AppendSourceRanges {
        asset_id: AssetId,
        ranges: Vec<SourceRange>,
        /// `None` appends at the end of the timeline; otherwise ripple-inserts there.
        #[serde(default)]
        at: Option<TimelineTime>,
    },
    AddText {
        text: String,
        start: TimelineTime,
        #[serde(default)]
        duration: Option<Ticks>,
        #[serde(default)]
        track_id: Option<TrackId>,
    },
    AddCaptions {
        cues: Vec<CueDraft>,
        #[serde(default)]
        track_id: Option<TrackId>,
    },
    /// Build captions from the transcripts of what is currently audible on the
    /// timeline, replacing previously generated captions.
    GenerateCaptions {
        #[serde(default)]
        options: CaptionOptions,
    },
    /// Paste / duplicate arbitrary clips.
    InsertClips {
        clips: Vec<ClipDraft>,
        at: TimelineTime,
        #[serde(default)]
        mode: PlaceMode,
    },
    DuplicateClips {
        clip_ids: Vec<ClipId>,
    },
    // ---- arranging -----------------------------------------------------------
    MoveClips {
        moves: Vec<ClipMove>,
        #[serde(default)]
        mode: PlaceMode,
    },
    /// Move one edge of the clips by `delta` output ticks. With `ripple` later
    /// material follows the edit so no gap or overwrite occurs.
    TrimClips {
        clip_ids: Vec<ClipId>,
        edge: Edge,
        delta: Ticks,
        #[serde(default)]
        ripple: bool,
    },
    /// Shift the source range shown by the clips without moving them.
    SlipClips {
        clip_ids: Vec<ClipId>,
        delta: Ticks,
    },
    /// Cut clips in two at a timeline position. `clip_ids: None` splits every clip
    /// under `at` on unlocked tracks.
    SplitClips {
        at: TimelineTime,
        #[serde(default)]
        clip_ids: Option<Vec<ClipId>>,
    },
    /// `ripple: false` is a lift delete (leaves a gap); `ripple: true` closes the gap.
    DeleteClips {
        clip_ids: Vec<ClipId>,
        #[serde(default)]
        ripple: bool,
    },
    /// Remove a timeline range from every unlocked track and close the gap.
    RippleDeleteRange {
        start: TimelineTime,
        end: TimelineTime,
    },
    /// Close the empty space around `at` on a track (ripple).
    CloseGap {
        track_id: TrackId,
        at: TimelineTime,
    },
    UpdateClips {
        clip_ids: Vec<ClipId>,
        patch: ClipPatch,
    },
    SetSpeed {
        clip_ids: Vec<ClipId>,
        speed: f64,
        #[serde(default = "yes")]
        ripple: bool,
    },
    LinkClips {
        clip_ids: Vec<ClipId>,
    },
    UnlinkClips {
        clip_ids: Vec<ClipId>,
    },
    GroupClips {
        clip_ids: Vec<ClipId>,
    },
    UngroupClips {
        clip_ids: Vec<ClipId>,
    },
    // ---- transitions ---------------------------------------------------------
    /// Add a transition on the cut *after* each listed clip.
    AddTransitions {
        left_clip_ids: Vec<ClipId>,
        kind: TransitionKind,
        duration: Ticks,
    },
    UpdateTransition {
        transition_id: TransitionId,
        #[serde(default)]
        kind: Option<TransitionKind>,
        #[serde(default)]
        duration: Option<Ticks>,
    },
    RemoveTransitions {
        transition_ids: Vec<TransitionId>,
    },
    // ---- markers -------------------------------------------------------------
    AddMarker {
        time: TimelineTime,
        #[serde(default)]
        label: String,
        #[serde(default)]
        color: Option<String>,
    },
    UpdateMarker {
        marker_id: MarkerId,
        #[serde(default)]
        time: Option<TimelineTime>,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        color: Option<String>,
    },
    RemoveMarker {
        marker_id: MarkerId,
    },
    // ---- media bin -----------------------------------------------------------
    /// Remove an asset from the project together with every clip that uses it.
    RemoveAsset {
        asset_id: AssetId,
    },
    // ---- transcript editing ----------------------------------------------------
    SetTranscriptEditing {
        enabled: bool,
    },
    /// Correct the displayed text of a transcript word. The provider tokens and
    /// timings stay untouched; `text: None` reverts to the original.
    CorrectWord {
        asset_id: AssetId,
        word_index: u32,
        #[serde(default)]
        text: Option<String>,
    },
    RenameSpeaker {
        asset_id: AssetId,
        speaker: String,
        #[serde(default)]
        name: Option<String>,
    },
    /// Transcript-driven ripple edit: remove source ranges (words, fillers,
    /// silences) from the clips that show them and close the gaps. Each cut is
    /// recorded in the project's removal trace.
    RippleDeleteSource {
        cuts: Vec<SourceCut>,
        reason: RemovalReason,
    },
    /// Undo a source removal structurally: re-insert the media that was cut out
    /// between each listed clip and its right-hand neighbour.
    HealCuts {
        left_clip_ids: Vec<ClipId>,
    },
    // ---- composition ---------------------------------------------------------
    /// Apply several commands as one atomic, single-undo-step transaction.
    Batch {
        commands: Vec<Command>,
        #[serde(default)]
        label: Option<String>,
    },
}

/// Result of a successfully applied command.
#[derive(Clone, Debug)]
pub struct Applied {
    pub project: Project,
    /// Human readable label for the undo history.
    pub label: String,
    /// Non-fatal information for the user (e.g. "gap could not be fully closed").
    pub notices: Vec<String>,
    /// Ids of clips created by the command.
    pub created: Vec<ClipId>,
}

/// Apply `cmd` to `project`, returning the new document or a rejection.
pub fn apply(project: &Project, cmd: &Command, env: &Env) -> CmdResult<Applied> {
    let mut w = Work {
        p: project.clone(),
        env,
        notices: Vec::new(),
        created: Vec::new(),
        split_links: BTreeMap::new(),
    };
    w.p.revision = project.revision + 1;
    let label = w.run(cmd, 0)?;
    validate::normalize(&mut w.p);
    if w.p.clips.values().any(|c| c.end().0 > MAX_TIMELINE_TICKS) {
        return Err(CommandError::conflict(
            "This edit would make the timeline longer than the 24-hour maximum.",
        ));
    }
    validate::validate(&w.p).map_err(CommandError::invariant)?;
    Ok(Applied {
        project: w.p,
        label,
        notices: w.notices,
        created: w.created,
    })
}

/// System mutation (not undoable, does not bump the revision): register a probed
/// asset in the project's media bin.
pub fn add_asset(project: &mut Project, info: AssetInfo) {
    project.assets.insert(info.id.clone(), info);
}

struct Work<'a> {
    p: Project,
    env: &'a Env,
    notices: Vec<String>,
    created: Vec<ClipId>,
    /// Link ids handed to the right-hand pieces of linked clips that an overwrite
    /// split at the same point, keyed by (original link, split position).
    split_links: BTreeMap<(String, TimelineTime), String>,
}

fn dedupe(ids: &[ClipId]) -> Vec<ClipId> {
    let mut seen = BTreeSet::new();
    ids.iter()
        .filter(|i| seen.insert((*i).clone()))
        .cloned()
        .collect()
}

fn check_finite(field: &str, v: f64, lo: f64, hi: f64) -> CmdResult<f64> {
    if !v.is_finite() || v < lo || v > hi {
        return Err(CommandError::invalid(
            field,
            format!("{field} must be between {lo} and {hi}"),
        ));
    }
    Ok(v)
}

pub(crate) fn is_color(s: &str, allow_alpha: bool) -> bool {
    let b = s.as_bytes();
    (b.len() == 7 || (allow_alpha && b.len() == 9))
        && b[0] == b'#'
        && b[1..].iter().all(|c| c.is_ascii_hexdigit())
}

fn check_color(field: &str, s: &str, allow_alpha: bool) -> CmdResult<String> {
    if !is_color(s, allow_alpha) {
        return Err(CommandError::invalid(
            field,
            format!("{field} must be a hex colour like #rrggbb"),
        ));
    }
    Ok(s.to_ascii_lowercase())
}

fn check_text(field: &str, s: &str, max: usize) -> CmdResult<String> {
    if s.chars().count() > max {
        return Err(CommandError::invalid(
            field,
            format!("{field} is too long (max {max} characters)"),
        ));
    }
    if s.chars().any(|c| c.is_control() && c != '\n') {
        return Err(CommandError::invalid(
            field,
            format!("{field} contains control characters"),
        ));
    }
    Ok(s.to_string())
}

impl<'a> Work<'a> {
    // -------------------------------------------------------------------------
    // lookups
    // -------------------------------------------------------------------------
    fn fps(&self) -> FrameRate {
        self.p.fps()
    }
    fn frame(&self) -> Ticks {
        self.p.fps().frame_ticks()
    }
    fn snap(&self, t: Ticks) -> Ticks {
        // Arguments come straight off the wire: bound them so frame arithmetic can
        // never overflow, whatever a client sends.
        self.p
            .fps()
            .snap(t.clamp(-2 * MAX_TIMELINE_TICKS, 2 * MAX_TIMELINE_TICKS))
    }
    fn snap_time(&self, field: &str, t: TimelineTime) -> CmdResult<TimelineTime> {
        if t.0 < 0 {
            return Err(CommandError::invalid(
                field,
                format!("{field} must not be negative"),
            ));
        }
        if t.0 > MAX_TIMELINE_TICKS {
            return Err(CommandError::invalid(
                field,
                format!("{field} is beyond the maximum timeline length"),
            ));
        }
        Ok(TimelineTime(self.snap(t.0)))
    }
    fn clip(&self, id: &str) -> CmdResult<&Clip> {
        self.p
            .clips
            .get(id)
            .ok_or_else(|| CommandError::not_found("Clip", id))
    }
    fn track(&self, id: &str) -> CmdResult<&Track> {
        self.p
            .track(id)
            .ok_or_else(|| CommandError::not_found("Track", id))
    }
    fn unlocked_track(&self, id: &str) -> CmdResult<&Track> {
        let t = self.track(id)?;
        if t.locked {
            return Err(CommandError::locked(&t.name));
        }
        Ok(t)
    }
    /// Validate a clip id list: non-empty, existing, on unlocked tracks.
    fn editable_clips(&self, ids: &[ClipId]) -> CmdResult<Vec<ClipId>> {
        let ids = dedupe(ids);
        if ids.is_empty() {
            return Err(CommandError::invalid(
                "clip_ids",
                "Select at least one clip",
            ));
        }
        for id in &ids {
            let c = self.clip(id)?;
            self.unlocked_track(&c.track_id)?;
        }
        Ok(ids)
    }
    fn is_locked(&self, track_id: &str) -> bool {
        self.p.track(track_id).map(|t| t.locked).unwrap_or(false)
    }
    fn track_kind(&self, track_id: &str) -> Option<TrackKind> {
        self.p.track(track_id).map(|t| t.kind)
    }
    /// Sorted (start, end, id) of the clips on a track.
    fn spans(&self, track_id: &str) -> Vec<(TimelineTime, TimelineTime, ClipId)> {
        let mut v: Vec<_> = self
            .p
            .clips
            .values()
            .filter(|c| c.track_id == track_id)
            .map(|c| (c.start, c.end(), c.id.clone()))
            .collect();
        v.sort();
        v
    }
    fn asset_duration_of(&self, c: &Clip) -> Option<Ticks> {
        if c.content.is_timed_media() {
            c.asset_id()
                .and_then(|a| self.p.assets.get(a))
                .map(|a| a.duration)
        } else {
            None
        }
    }

    // -------------------------------------------------------------------------
    // primitive edits
    // -------------------------------------------------------------------------

    /// Split a clip at `t` (must be strictly inside). Returns the id of the right part.
    fn split_one(&mut self, id: &str, t: TimelineTime) -> ClipId {
        let orig = self.p.clips[id].clone();
        debug_assert!(t > orig.start && t < orig.end());
        let new_id = self.p.gen_id("c");
        let mut right = orig.clone();
        right.id = new_id.clone();
        right.start = t;
        right.duration = orig.end() - t;
        if orig.content.is_timed_media() {
            right.source_in = orig.source_time_at(t);
        }
        right.fade_in = 0;
        let left = self.p.clips.get_mut(id).unwrap();
        left.duration = t - orig.start;
        left.fade_out = 0;
        for tr in self.p.transitions.values_mut() {
            if tr.left == id {
                tr.left = new_id.clone();
            }
        }
        self.p.clips.insert(new_id.clone(), right);
        new_id
    }

    /// After splitting, right-hand pieces whose originals were linked to each other
    /// become a new link set; a lone right-hand piece is unlinked.
    fn relink_split(&mut self, pairs: &[(ClipId, ClipId)]) {
        let mut by_link: BTreeMap<String, Vec<ClipId>> = BTreeMap::new();
        for (orig, right) in pairs {
            if let Some(l) = self.p.clips.get(orig).and_then(|c| c.link_id.clone()) {
                by_link.entry(l).or_default().push(right.clone());
            }
        }
        for (_, rights) in by_link {
            let new_link = if rights.len() >= 2 {
                Some(self.p.gen_id("l"))
            } else {
                None
            };
            for r in rights {
                if let Some(c) = self.p.clips.get_mut(&r) {
                    c.link_id = new_link.clone();
                }
            }
        }
    }

    /// Clear `[start, end)` on a track: clips inside are removed, clips crossing an
    /// edge are trimmed, a clip spanning the range is split around it.
    fn overwrite_range(
        &mut self,
        track_id: &str,
        start: TimelineTime,
        end: TimelineTime,
        exclude: &BTreeSet<ClipId>,
    ) {
        if end <= start {
            return;
        }
        let hits: Vec<ClipId> = self
            .p
            .clips
            .values()
            .filter(|c| {
                c.track_id == track_id && c.overlaps(start, end) && !exclude.contains(&c.id)
            })
            .map(|c| c.id.clone())
            .collect();
        for id in hits {
            let (c_start, c_end) = {
                let c = &self.p.clips[&id];
                (c.start, c.end())
            };
            if c_start >= start && c_end <= end {
                self.p.clips.remove(&id);
            } else if c_start < start && c_end > end {
                // spans the range: keep both outer parts
                let right = self.split_one(&id, end);
                // Right-hand pieces of linked clips cut at the same point stay linked
                // to each other, not to the left-hand pieces (same rule as a split).
                if let Some(link) = self.p.clips[&id].link_id.clone() {
                    let key = (link, end);
                    let new_link = match self.split_links.get(&key) {
                        Some(l) => l.clone(),
                        None => {
                            let l = self.p.gen_id("l");
                            self.split_links.insert(key, l.clone());
                            l
                        }
                    };
                    self.p.clips.get_mut(&right).unwrap().link_id = Some(new_link);
                }
                let left = self.p.clips.get_mut(&id).unwrap();
                left.duration = start - c_start;
            } else if c_start < start {
                let c = self.p.clips.get_mut(&id).unwrap();
                c.duration = start - c_start;
                c.fade_out = 0;
            } else {
                let c = self.p.clips.get_mut(&id).unwrap();
                if c.content.is_timed_media() {
                    c.source_in = c.source_time_at(end);
                }
                c.start = end;
                c.duration = c_end - end;
                c.fade_in = 0;
            }
        }
    }

    /// Shift every clip (and marker) starting at or after `t` on unlocked tracks.
    fn shift_from(&mut self, t: TimelineTime, delta: Ticks, exclude: &BTreeSet<ClipId>) {
        if delta == 0 {
            return;
        }
        let locked: BTreeSet<&str> = self
            .p
            .tracks
            .iter()
            .filter(|t| t.locked)
            .map(|t| t.id.as_str())
            .collect();
        for c in self.p.clips.values_mut() {
            if c.start >= t && !locked.contains(c.track_id.as_str()) && !exclude.contains(&c.id) {
                c.start += delta;
            }
        }
        for m in self.p.markers.iter_mut() {
            if m.time >= t {
                m.time = TimelineTime((m.time.0 + delta).max(0));
            }
        }
    }

    /// Close the (already emptied) range `[s, e)` by pulling later material left on
    /// all unlocked tracks. To keep every track in sync a single shift amount is
    /// used: the largest one that does not make any clip collide with material that
    /// still overlaps the range on its track. Returns the amount actually closed.
    fn ripple_close(&mut self, s: TimelineTime, e: TimelineTime) -> Ticks {
        let len = e - s;
        if len <= 0 {
            return 0;
        }
        let mut room = len;
        for track in &self.p.tracks {
            if track.locked || track.kind == TrackKind::Caption {
                continue;
            }
            let mut first_later: Option<TimelineTime> = None;
            let mut prev_end = s;
            for c in self.p.clips.values().filter(|c| c.track_id == track.id) {
                if c.start >= e {
                    first_later = Some(first_later.map_or(c.start, |f| f.min(c.start)));
                } else if c.end() > prev_end {
                    prev_end = c.end();
                }
            }
            if let Some(fl) = first_later {
                room = room.min((fl - prev_end).max(0));
            }
        }
        let d = room;
        if d <= 0 {
            return 0;
        }
        // Captions describing the removed stretch go with it.
        let caption_tracks: Vec<TrackId> = self
            .p
            .tracks
            .iter()
            .filter(|t| t.kind == TrackKind::Caption && !t.locked)
            .map(|t| t.id.clone())
            .collect();
        let none = BTreeSet::new();
        for ct in caption_tracks {
            self.overwrite_range(&ct, e - d, e, &none);
        }
        self.p.markers.retain(|m| !(m.time > e - d && m.time < e));
        self.shift_from(e, -d, &none);
        d
    }

    fn merged_intervals(
        mut v: Vec<(TimelineTime, TimelineTime)>,
    ) -> Vec<(TimelineTime, TimelineTime)> {
        v.sort();
        let mut out: Vec<(TimelineTime, TimelineTime)> = Vec::new();
        for (s, e) in v {
            match out.last_mut() {
                Some(last) if s <= last.1 => {
                    if e > last.1 {
                        last.1 = e;
                    }
                }
                _ => out.push((s, e)),
            }
        }
        out
    }

    /// Find or create the track of `kind` with the given 0-based ordinal.
    fn ensure_track(&mut self, kind: TrackKind, ordinal: usize) -> CmdResult<TrackId> {
        loop {
            let existing = self.p.tracks_of_kind(kind);
            if let Some(t) = existing.get(ordinal) {
                return Ok(t.id.clone());
            }
            self.add_track(kind, None)?;
        }
    }

    fn add_track(&mut self, kind: TrackKind, name: Option<String>) -> CmdResult<TrackId> {
        if self.p.tracks.len() >= MAX_TRACKS {
            return Err(CommandError::conflict(format!(
                "A project can have at most {MAX_TRACKS} tracks"
            )));
        }
        let n = self.p.tracks.iter().filter(|t| t.kind == kind).count() + 1;
        let name = match name {
            Some(n) => {
                let n = check_text("name", n.trim(), 40)?;
                if n.is_empty() {
                    return Err(CommandError::invalid(
                        "name",
                        "Track name must not be empty",
                    ));
                }
                n
            }
            None => format!("{}{}", kind.prefix(), n),
        };
        let id = self.p.gen_id("t");
        let track = Track {
            id: id.clone(),
            kind,
            name,
            muted: false,
            solo: false,
            locked: false,
            hidden: false,
            gain_db: 0.0,
        };
        match kind {
            TrackKind::Caption => self.p.tracks.insert(0, track),
            TrackKind::Video => {
                let idx = self
                    .p
                    .tracks
                    .iter()
                    .take_while(|t| t.kind == TrackKind::Caption)
                    .count();
                self.p.tracks.insert(idx, track);
            }
            TrackKind::Audio => self.p.tracks.push(track),
        }
        Ok(id)
    }

    fn caption_track(&mut self, requested: Option<&str>) -> CmdResult<TrackId> {
        if let Some(id) = requested {
            let t = self.unlocked_track(id)?;
            if t.kind != TrackKind::Caption {
                return Err(CommandError::invalid(
                    "track_id",
                    "Captions can only be placed on a caption track",
                ));
            }
            return Ok(id.to_string());
        }
        if let Some(t) = self
            .p
            .tracks
            .iter()
            .find(|t| t.kind == TrackKind::Caption && !t.locked)
        {
            return Ok(t.id.clone());
        }
        self.add_track(TrackKind::Caption, None)
    }

    fn new_clip(
        &mut self,
        track_id: &str,
        start: TimelineTime,
        duration: Ticks,
        source_in: SourceTime,
        content: ClipContent,
    ) -> ClipId {
        let id = self.p.gen_id("c");
        let clip = Clip {
            id: id.clone(),
            track_id: track_id.to_string(),
            start,
            duration,
            source_in,
            speed: Speed::NORMAL,
            content,
            enabled: true,
            link_id: None,
            group_id: None,
            transform: Transform::default(),
            color: ColorAdjust::default(),
            gain_db: 0.0,
            fade_in: 0,
            fade_out: 0,
        };
        self.p.clips.insert(id.clone(), clip);
        self.created.push(id.clone());
        id
    }

    /// Split any clip on unlocked tracks that spans `t`, so a ripple insert at `t`
    /// keeps all tracks in sync.
    fn split_all_at(&mut self, t: TimelineTime) {
        let hits: Vec<ClipId> = self
            .p
            .clips
            .values()
            .filter(|c| c.start < t && c.end() > t && !self.is_locked(&c.track_id))
            .map(|c| c.id.clone())
            .collect();
        let mut pairs = Vec::new();
        for id in hits {
            let r = self.split_one(&id, t);
            pairs.push((id, r));
        }
        self.relink_split(&pairs);
    }

    // -------------------------------------------------------------------------
    // dispatcher
    // -------------------------------------------------------------------------
    fn run(&mut self, cmd: &Command, depth: usize) -> CmdResult<String> {
        match cmd {
            Command::UpdateSettings {
                width,
                height,
                fps,
                background,
                caption_style,
            } => self.update_settings(
                *width,
                *height,
                *fps,
                background.as_deref(),
                caption_style.as_ref(),
            ),
            Command::AddTrack { kind, name } => {
                self.add_track(*kind, name.clone())?;
                Ok("Add track".into())
            }
            Command::RemoveTrack { track_id } => self.remove_track(track_id),
            Command::UpdateTrack {
                track_id,
                name,
                muted,
                solo,
                locked,
                hidden,
                gain_db,
            } => {
                self.track(track_id)?;
                let name = match name {
                    Some(n) => {
                        let n = check_text("name", n.trim(), 40)?;
                        if n.is_empty() {
                            return Err(CommandError::invalid(
                                "name",
                                "Track name must not be empty",
                            ));
                        }
                        Some(n)
                    }
                    None => None,
                };
                if let Some(g) = gain_db {
                    check_finite("gain_db", *g, -60.0, 12.0)?;
                }
                let t = self
                    .p
                    .tracks
                    .iter_mut()
                    .find(|t| &t.id == track_id)
                    .unwrap();
                if let Some(n) = name {
                    t.name = n;
                }
                if let Some(v) = muted {
                    t.muted = *v;
                }
                if let Some(v) = solo {
                    t.solo = *v;
                }
                if let Some(v) = locked {
                    t.locked = *v;
                }
                if let Some(v) = hidden {
                    t.hidden = *v;
                }
                if let Some(v) = gain_db {
                    t.gain_db = *v;
                }
                Ok("Update track".into())
            }
            Command::MoveTrack { track_id, ordinal } => self.move_track(track_id, *ordinal),
            Command::AddAssetClips {
                asset_id,
                start,
                track_id,
                source_in,
                source_out,
                mode,
            } => {
                self.add_asset_clips(
                    asset_id,
                    *start,
                    track_id.as_deref(),
                    *source_in,
                    *source_out,
                    *mode,
                )?;
                Ok("Add clip".into())
            }
            Command::AppendSourceRanges {
                asset_id,
                ranges,
                at,
            } => self.append_source_ranges(asset_id, ranges, *at),
            Command::AddText {
                text,
                start,
                duration,
                track_id,
            } => self.add_text(text, *start, *duration, track_id.as_deref()),
            Command::AddCaptions { cues, track_id } => {
                if cues.is_empty() {
                    return Err(CommandError::invalid("cues", "No captions to add"));
                }
                let track = self.caption_track(track_id.as_deref())?;
                self.place_cues(&track, cues, false)?;
                Ok(if cues.len() == 1 {
                    "Add caption".into()
                } else {
                    format!("Add {} captions", cues.len())
                })
            }
            Command::GenerateCaptions { options } => {
                options.validate()?;
                let cues = captions::generate_cues(&self.p, &self.env.transcripts, options);
                if cues.is_empty() {
                    return Err(CommandError::conflict(
                        "No transcribed speech on the timeline yet. Enable transcript editing and wait for transcription to finish, then try again.",
                    ));
                }
                let track = self.caption_track(None)?;
                let old: Vec<ClipId> = self
                    .p
                    .clips
                    .values()
                    .filter(|c| {
                        c.track_id == track
                            && matches!(
                                c.content,
                                ClipContent::Caption {
                                    generated: true,
                                    ..
                                }
                            )
                    })
                    .map(|c| c.id.clone())
                    .collect();
                for id in old {
                    self.p.clips.remove(&id);
                }
                // Captions the user wrote or edited by hand are theirs: new cues never
                // overwrite them (the hand-made caption wins where they would overlap).
                let kept = self.spans(&track);
                let fps = self.fps();
                let frame = self.frame();
                let cues: Vec<CueDraft> = cues
                    .into_iter()
                    .filter(|c| {
                        let s = TimelineTime(fps.snap(c.start.0));
                        let e = s + fps.snap(c.duration).max(frame);
                        !kept.iter().any(|k| k.0 < e && k.1 > s)
                    })
                    .collect();
                if cues.is_empty() {
                    return Err(CommandError::conflict(
                        "Every caption here was written or edited by hand, so there is nothing to regenerate. Delete the captions you want rebuilt and try again.",
                    ));
                }
                let n = cues.len();
                self.place_cues(&track, &cues, true)?;
                Ok(format!("Generate {n} captions"))
            }
            Command::InsertClips { clips, at, mode } => self.insert_clips(clips, *at, *mode),
            Command::DuplicateClips { clip_ids } => self.duplicate_clips(clip_ids),
            Command::MoveClips { moves, mode } => self.move_clips(moves, *mode),
            Command::TrimClips {
                clip_ids,
                edge,
                delta,
                ripple,
            } => self.trim_clips(clip_ids, *edge, *delta, *ripple),
            Command::SlipClips { clip_ids, delta } => self.slip_clips(clip_ids, *delta),
            Command::SplitClips { at, clip_ids } => self.split_clips(*at, clip_ids.as_deref()),
            Command::DeleteClips { clip_ids, ripple } => self.delete_clips(clip_ids, *ripple),
            Command::RippleDeleteRange { start, end } => {
                let s = self.snap_time("start", *start)?;
                let e = self.snap_time("end", *end)?;
                if e <= s {
                    return Err(CommandError::invalid(
                        "end",
                        "The range end must be after its start",
                    ));
                }
                let tracks: Vec<TrackId> = self
                    .p
                    .tracks
                    .iter()
                    .filter(|t| !t.locked)
                    .map(|t| t.id.clone())
                    .collect();
                let none = BTreeSet::new();
                for t in &tracks {
                    self.overwrite_range(t, s, e, &none);
                }
                self.p.markers.retain(|m| !(m.time > s && m.time < e));
                self.shift_from(e, -(e - s), &none);
                Ok("Ripple delete range".into())
            }
            Command::CloseGap { track_id, at } => self.close_gap(track_id, *at),
            Command::UpdateClips { clip_ids, patch } => self.update_clips(clip_ids, patch),
            Command::SetSpeed {
                clip_ids,
                speed,
                ripple,
            } => self.set_speed(clip_ids, *speed, *ripple),
            Command::LinkClips { clip_ids } => {
                let ids = self.editable_clips(clip_ids)?;
                if ids.len() < 2 {
                    return Err(CommandError::invalid(
                        "clip_ids",
                        "Select at least two clips to link",
                    ));
                }
                let link = self.p.gen_id("l");
                for id in &ids {
                    self.p.clips.get_mut(id).unwrap().link_id = Some(link.clone());
                }
                Ok("Link clips".into())
            }
            Command::UnlinkClips { clip_ids } => {
                let ids = self.editable_clips(clip_ids)?;
                if !ids.iter().any(|id| self.p.clips[id].link_id.is_some()) {
                    return Err(CommandError::conflict("The selected clips are not linked"));
                }
                for id in &ids {
                    self.p.clips.get_mut(id).unwrap().link_id = None;
                }
                Ok("Unlink clips".into())
            }
            Command::GroupClips { clip_ids } => {
                let ids = self.editable_clips(clip_ids)?;
                if ids.len() < 2 {
                    return Err(CommandError::invalid(
                        "clip_ids",
                        "Select at least two clips to group",
                    ));
                }
                let group = self.p.gen_id("g");
                for id in &ids {
                    self.p.clips.get_mut(id).unwrap().group_id = Some(group.clone());
                }
                Ok("Group clips".into())
            }
            Command::UngroupClips { clip_ids } => {
                let ids = self.editable_clips(clip_ids)?;
                let groups: BTreeSet<String> = ids
                    .iter()
                    .filter_map(|id| self.p.clips[id].group_id.clone())
                    .collect();
                if groups.is_empty() {
                    return Err(CommandError::conflict("The selected clips are not grouped"));
                }
                for c in self.p.clips.values_mut() {
                    if c.group_id.as_ref().is_some_and(|g| groups.contains(g)) {
                        c.group_id = None;
                    }
                }
                Ok("Ungroup clips".into())
            }
            Command::AddTransitions {
                left_clip_ids,
                kind,
                duration,
            } => self.add_transitions(left_clip_ids, *kind, *duration),
            Command::UpdateTransition {
                transition_id,
                kind,
                duration,
            } => self.update_transition(transition_id, *kind, *duration),
            Command::RemoveTransitions { transition_ids } => {
                if transition_ids.is_empty() {
                    return Err(CommandError::invalid(
                        "transition_ids",
                        "No transition selected",
                    ));
                }
                for id in transition_ids {
                    if self.p.transitions.remove(id).is_none() {
                        return Err(CommandError::not_found("Transition", id));
                    }
                }
                Ok("Remove transition".into())
            }
            Command::AddMarker { time, label, color } => {
                let time = self.snap_time("time", *time)?;
                let label = check_text("label", label.trim(), 80)?;
                let color = match color {
                    Some(c) => check_color("color", c, false)?,
                    None => "#f5c542".to_string(),
                };
                let id = self.p.gen_id("m");
                self.p.markers.push(Marker {
                    id,
                    time,
                    label,
                    color,
                });
                self.p.markers.sort_by_key(|m| (m.time, m.id.clone()));
                Ok("Add marker".into())
            }
            Command::UpdateMarker {
                marker_id,
                time,
                label,
                color,
            } => {
                let time = match time {
                    Some(t) => Some(self.snap_time("time", *t)?),
                    None => None,
                };
                let label = match label {
                    Some(l) => Some(check_text("label", l.trim(), 80)?),
                    None => None,
                };
                let color = match color {
                    Some(c) => Some(check_color("color", c, false)?),
                    None => None,
                };
                let m = self
                    .p
                    .markers
                    .iter_mut()
                    .find(|m| &m.id == marker_id)
                    .ok_or_else(|| CommandError::not_found("Marker", marker_id))?;
                if let Some(t) = time {
                    m.time = t;
                }
                if let Some(l) = label {
                    m.label = l;
                }
                if let Some(c) = color {
                    m.color = c;
                }
                self.p.markers.sort_by_key(|m| (m.time, m.id.clone()));
                Ok("Edit marker".into())
            }
            Command::RemoveMarker { marker_id } => {
                let before = self.p.markers.len();
                self.p.markers.retain(|m| &m.id != marker_id);
                if self.p.markers.len() == before {
                    return Err(CommandError::not_found("Marker", marker_id));
                }
                Ok("Remove marker".into())
            }
            Command::RemoveAsset { asset_id } => {
                if self.p.assets.remove(asset_id).is_none() {
                    return Err(CommandError::not_found("Asset", asset_id));
                }
                let users: Vec<ClipId> = self
                    .p
                    .clips
                    .values()
                    .filter(|c| c.asset_id() == Some(asset_id.as_str()))
                    .map(|c| c.id.clone())
                    .collect();
                for id in &users {
                    let track_id = self.p.clips[id].track_id.clone();
                    self.unlocked_track(&track_id)?;
                    self.p.clips.remove(id);
                }
                self.p.transcript.corrections.remove(asset_id);
                self.p.transcript.speaker_names.remove(asset_id);
                Ok("Remove media".into())
            }
            Command::SetTranscriptEditing { enabled } => {
                self.p.transcript.enabled = *enabled;
                Ok(if *enabled {
                    "Enable transcript editing".into()
                } else {
                    "Disable transcript editing".into()
                })
            }
            Command::CorrectWord {
                asset_id,
                word_index,
                text,
            } => self.correct_word(asset_id, *word_index, text.as_deref()),
            Command::RenameSpeaker {
                asset_id,
                speaker,
                name,
            } => {
                if !self.p.assets.contains_key(asset_id) {
                    return Err(CommandError::not_found("Asset", asset_id));
                }
                if speaker.is_empty() || speaker.len() > 64 {
                    return Err(CommandError::invalid("speaker", "Invalid speaker id"));
                }
                match name.as_deref().map(str::trim) {
                    Some(n) if !n.is_empty() => {
                        let n = check_text("name", n, 60)?;
                        if n.contains('\n') {
                            return Err(CommandError::invalid(
                                "name",
                                "Speaker name must be a single line",
                            ));
                        }
                        self.p
                            .transcript
                            .speaker_names
                            .entry(asset_id.clone())
                            .or_default()
                            .insert(speaker.clone(), n);
                    }
                    _ => {
                        if let Some(m) = self.p.transcript.speaker_names.get_mut(asset_id) {
                            m.remove(speaker);
                            if m.is_empty() {
                                self.p.transcript.speaker_names.remove(asset_id);
                            }
                        }
                    }
                }
                Ok("Rename speaker".into())
            }
            Command::RippleDeleteSource { cuts, reason } => {
                self.ripple_delete_source(cuts, *reason)
            }
            Command::HealCuts { left_clip_ids } => self.heal_cuts(left_clip_ids),
            Command::Batch { commands, label } => {
                if depth > 0 {
                    return Err(CommandError::invalid(
                        "commands",
                        "Batches cannot be nested",
                    ));
                }
                if commands.is_empty() {
                    return Err(CommandError::invalid(
                        "commands",
                        "A batch needs at least one command",
                    ));
                }
                if commands.len() > 2000 {
                    return Err(CommandError::invalid(
                        "commands",
                        "A batch may contain at most 2000 commands",
                    ));
                }
                let mut first = String::new();
                for (i, c) in commands.iter().enumerate() {
                    let l = self.run(c, depth + 1).map_err(|mut e| {
                        e.message = format!("Step {} of the batch failed: {}", i + 1, e.message);
                        e
                    })?;
                    // keep the document tidy between steps so later steps see valid state
                    validate::normalize(&mut self.p);
                    if i == 0 {
                        first = l;
                    }
                }
                Ok(label.clone().unwrap_or(if commands.len() == 1 {
                    first
                } else {
                    format!("{} edits", commands.len())
                }))
            }
        }
    }

    // -------------------------------------------------------------------------
    // settings & tracks
    // -------------------------------------------------------------------------
    fn update_settings(
        &mut self,
        width: Option<u32>,
        height: Option<u32>,
        fps: Option<FrameRate>,
        background: Option<&str>,
        caption_style: Option<&CaptionStyle>,
    ) -> CmdResult<String> {
        for (field, v) in [("width", width), ("height", height)] {
            if let Some(v) = v {
                if !(MIN_DIMENSION..=MAX_DIMENSION).contains(&v) || v % 2 != 0 {
                    return Err(CommandError::invalid(field, format!("{field} must be an even number between {MIN_DIMENSION} and {MAX_DIMENSION}")));
                }
            }
        }
        if let Some(w) = width {
            self.p.settings.width = w;
        }
        if let Some(h) = height {
            self.p.settings.height = h;
        }
        if let Some(bg) = background {
            self.p.settings.background = check_color("background", bg, false)?;
        }
        if let Some(cs) = caption_style {
            validate_text_style(&cs.text)?;
            check_finite("caption_style.y", cs.y, -0.5, 0.5)?;
            self.p.settings.caption_style = cs.clone();
        }
        if let Some(f) = fps {
            let f = FrameRate::new(f.num, f.den)
                .ok_or_else(|| CommandError::invalid("fps", "Invalid frame rate"))?;
            if f.as_f64() > MAX_FPS + 1e-6 {
                return Err(CommandError::invalid(
                    "fps",
                    format!("Frame rate must not exceed {MAX_FPS} fps"),
                ));
            }
            if f != self.p.settings.fps {
                self.p.settings.fps = f;
                // Conform every edit point to the new frame grid. Start and end are
                // snapped independently so adjacent clips stay adjacent.
                let frame = f.frame_ticks();
                let media: BTreeMap<AssetId, Ticks> = self
                    .p
                    .assets
                    .iter()
                    .map(|(id, a)| (id.clone(), a.duration))
                    .collect();
                for c in self.p.clips.values_mut() {
                    let s = f.snap(c.start.0);
                    let mut e = f.snap(c.end().0);
                    if e <= s {
                        e = s + frame;
                    }
                    // Rounding the out point up must not run past the end of the media
                    // (the tolerance is one frame of the *new*, possibly finer, grid).
                    if c.content.is_timed_media() {
                        if let Some(ad) = c.asset_id().and_then(|a| media.get(a)) {
                            let max = f
                                .snap_floor(c.speed.source_to_output(ad - c.source_in.0))
                                .max(frame);
                            e = e.min(s + max);
                        }
                    }
                    c.start = TimelineTime(s);
                    c.duration = e - s;
                    c.fade_in = f.snap(c.fade_in);
                    c.fade_out = f.snap(c.fade_out);
                }
                for m in self.p.markers.iter_mut() {
                    m.time = TimelineTime(f.snap(m.time.0));
                }
                for t in self.p.transitions.values_mut() {
                    t.duration = even_frames(f, t.duration);
                }
                // Clips shorter than one new frame were stretched to a full frame; if
                // that makes them collide, refuse with an explanation.
                let mut spans: Vec<(&str, Ticks, Ticks)> = self
                    .p
                    .clips
                    .values()
                    .map(|c| (c.track_id.as_str(), c.start.0, c.end().0))
                    .collect();
                spans.sort();
                if spans
                    .windows(2)
                    .any(|w| w[0].0 == w[1].0 && w[1].1 < w[0].2)
                {
                    return Err(CommandError::conflict(
                        "Some clips are shorter than one frame at this frame rate and would overlap. Lengthen or remove them, then change the frame rate.",
                    ));
                }
            }
        }
        Ok("Change project settings".into())
    }

    fn remove_track(&mut self, track_id: &str) -> CmdResult<String> {
        let t = self.unlocked_track(track_id)?.clone();
        if t.kind != TrackKind::Caption
            && self.p.tracks.iter().filter(|x| x.kind == t.kind).count() <= 1
        {
            return Err(CommandError::conflict(format!(
                "A project needs at least one {} track",
                if t.kind == TrackKind::Video {
                    "video"
                } else {
                    "audio"
                }
            )));
        }
        self.p.clips.retain(|_, c| c.track_id != track_id);
        self.p.tracks.retain(|x| x.id != track_id);
        self.renumber_default_names();
        Ok(format!("Remove track {}", t.name))
    }

    /// Keep automatic track names (V1, A2, …) in step with the track order after a
    /// removal or reorder. Tracks the user renamed are left alone.
    fn renumber_default_names(&mut self) {
        for kind in [TrackKind::Video, TrackKind::Audio, TrackKind::Caption] {
            let ids: Vec<TrackId> = self
                .p
                .tracks_of_kind(kind)
                .iter()
                .map(|t| t.id.clone())
                .collect();
            for (i, id) in ids.iter().enumerate() {
                if let Some(t) = self.p.tracks.iter_mut().find(|t| &t.id == id) {
                    let automatic = t.name.strip_prefix(kind.prefix()).is_some_and(|rest| {
                        !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit())
                    });
                    if automatic {
                        t.name = format!("{}{}", kind.prefix(), i + 1);
                    }
                }
            }
        }
    }

    fn move_track(&mut self, track_id: &str, ordinal: usize) -> CmdResult<String> {
        let kind = self.track(track_id)?.kind;
        // tracks of this kind in ordinal order
        let mut ids: Vec<TrackId> = self
            .p
            .tracks_of_kind(kind)
            .iter()
            .map(|t| t.id.clone())
            .collect();
        if ordinal >= ids.len() {
            return Err(CommandError::invalid(
                "ordinal",
                "Track position is out of range",
            ));
        }
        let from = ids.iter().position(|i| i == track_id).unwrap();
        let id = ids.remove(from);
        ids.insert(ordinal, id);
        // write back into display order
        let display: Vec<TrackId> = if kind == TrackKind::Audio {
            ids
        } else {
            ids.into_iter().rev().collect()
        };
        let slots: Vec<usize> = self
            .p
            .tracks
            .iter()
            .enumerate()
            .filter(|(_, t)| t.kind == kind)
            .map(|(i, _)| i)
            .collect();
        let by_id: BTreeMap<TrackId, Track> = self
            .p
            .tracks
            .iter()
            .filter(|t| t.kind == kind)
            .map(|t| (t.id.clone(), t.clone()))
            .collect();
        for (slot, id) in slots.into_iter().zip(display) {
            self.p.tracks[slot] = by_id[&id].clone();
        }
        self.renumber_default_names();
        Ok("Reorder tracks".into())
    }

    // -------------------------------------------------------------------------
    // adding clips
    // -------------------------------------------------------------------------
    fn add_asset_clips(
        &mut self,
        asset_id: &str,
        start: Option<TimelineTime>,
        track_id: Option<&str>,
        source_in: Option<SourceTime>,
        source_out: Option<SourceTime>,
        mode: PlaceMode,
    ) -> CmdResult<Vec<ClipId>> {
        let asset = self
            .p
            .assets
            .get(asset_id)
            .cloned()
            .ok_or_else(|| CommandError::not_found("Asset", asset_id))?;
        let fps = self.fps();
        let frame = self.frame();
        if asset.kind == AssetKind::Subtitle {
            return self.add_subtitle_asset(&asset, start, track_id);
        }
        let (s_in, duration) = match asset.kind {
            AssetKind::Image => {
                let d = match (source_in, source_out) {
                    (Some(a), Some(b)) if b > a => b.0.saturating_sub(a.0),
                    _ => DEFAULT_STILL_DURATION,
                };
                (SourceTime::ZERO, self.snap(d).max(frame))
            }
            _ => {
                let a = source_in.unwrap_or(SourceTime::ZERO);
                let b = source_out.unwrap_or(SourceTime(asset.duration));
                if a.0 < 0 || a.0 > asset.duration {
                    return Err(CommandError::invalid(
                        "source_in",
                        "source_in is outside the media",
                    ));
                }
                if b.0 > asset.duration + frame || b <= a {
                    return Err(CommandError::invalid(
                        "source_out",
                        "source_out must be after source_in and inside the media",
                    ));
                }
                let b = SourceTime(b.0.min(asset.duration));
                (a, fps.snap_floor(b - a).max(frame))
            }
        };
        let want_video =
            asset.kind == AssetKind::Image || (asset.kind == AssetKind::Video && asset.has_video);
        let want_audio = asset.kind != AssetKind::Image && asset.has_audio;
        if !want_video && !want_audio {
            return Err(CommandError::conflict(
                "This media has no playable video or audio stream",
            ));
        }
        // Resolve target tracks. A video track N pairs with audio track N.
        let (mut vt, mut at): (Option<TrackId>, Option<TrackId>) = (None, None);
        match track_id {
            Some(tid) => {
                let t = self.unlocked_track(tid)?.clone();
                let ordinal = self.p.track_ordinal(tid).unwrap_or(0);
                match t.kind {
                    TrackKind::Video => {
                        if !want_video {
                            return Err(CommandError::invalid(
                                "track_id",
                                "Audio can only be placed on an audio track",
                            ));
                        }
                        vt = Some(t.id.clone());
                        if want_audio {
                            at = Some(self.unlocked_or_new(TrackKind::Audio, ordinal)?);
                        }
                    }
                    TrackKind::Audio => {
                        if !want_audio {
                            return Err(CommandError::invalid(
                                "track_id",
                                "This media has no audio; place it on a video track",
                            ));
                        }
                        at = Some(t.id.clone());
                        if want_video {
                            vt = Some(self.unlocked_or_new(TrackKind::Video, ordinal)?);
                        }
                    }
                    TrackKind::Caption => {
                        return Err(CommandError::invalid(
                            "track_id",
                            "Media cannot be placed on a caption track",
                        ))
                    }
                }
            }
            None => {
                if want_video {
                    vt = Some(self.unlocked_or_new(TrackKind::Video, 0)?);
                }
                if want_audio {
                    at = Some(self.unlocked_or_new(TrackKind::Audio, 0)?);
                }
            }
        }
        let targets: Vec<TrackId> = vt.iter().chain(at.iter()).cloned().collect();
        let start = match start {
            Some(t) => self.snap_time("start", t)?,
            None => TimelineTime(
                targets
                    .iter()
                    .flat_map(|t| self.spans(t))
                    .map(|s| s.1 .0)
                    .max()
                    .unwrap_or(0),
            ),
        };
        let none = BTreeSet::new();
        match mode {
            PlaceMode::Insert => {
                self.split_all_at(start);
                self.shift_from(start, duration, &none);
            }
            PlaceMode::Overwrite => {
                for t in &targets {
                    self.overwrite_range(t, start, start + duration, &none);
                }
            }
        }
        let mut ids = Vec::new();
        if let Some(vt) = &vt {
            let content = if asset.kind == AssetKind::Image {
                ClipContent::Image {
                    asset_id: asset.id.clone(),
                }
            } else {
                ClipContent::Video {
                    asset_id: asset.id.clone(),
                }
            };
            ids.push(self.new_clip(vt, start, duration, s_in, content));
        }
        if let Some(at) = &at {
            ids.push(self.new_clip(
                at,
                start,
                duration,
                s_in,
                ClipContent::Audio {
                    asset_id: asset.id.clone(),
                },
            ));
        }
        if ids.len() == 2 {
            let link = self.p.gen_id("l");
            for id in &ids {
                self.p.clips.get_mut(id).unwrap().link_id = Some(link.clone());
            }
        }
        Ok(ids)
    }

    /// The track of `kind` at `ordinal` if unlocked, else the next unlocked one,
    /// creating a new track when all are locked.
    fn unlocked_or_new(&mut self, kind: TrackKind, ordinal: usize) -> CmdResult<TrackId> {
        let existing: Vec<(TrackId, bool)> = self
            .p
            .tracks_of_kind(kind)
            .iter()
            .map(|t| (t.id.clone(), t.locked))
            .collect();
        for (id, locked) in existing.iter().skip(ordinal) {
            if !locked {
                return Ok(id.clone());
            }
        }
        if ordinal >= existing.len() {
            return self.ensure_track(kind, ordinal);
        }
        self.add_track(kind, None)
    }

    fn add_subtitle_asset(
        &mut self,
        asset: &AssetInfo,
        start: Option<TimelineTime>,
        track_id: Option<&str>,
    ) -> CmdResult<Vec<ClipId>> {
        let cues = self.env.subtitles.get(&asset.id).cloned().ok_or_else(|| {
            CommandError::conflict(
                "The subtitle file is still being processed. Try again in a moment.",
            )
        })?;
        if cues.is_empty() {
            return Err(CommandError::conflict("The subtitle file contains no cues"));
        }
        let base = match start {
            Some(t) => self.snap_time("start", t)?,
            None => TimelineTime::ZERO,
        };
        let fps = self.fps();
        let frame = self.frame();
        let mut drafts: Vec<CueDraft> = Vec::new();
        let mut cursor = base;
        for c in cues.iter() {
            const DAY_MS: i64 = 24 * 3600 * 1000;
            let s = TimelineTime(
                fps.snap(base.0 + crate::time::ms_to_ticks(c.start_ms.clamp(0, DAY_MS))),
            )
            .max(cursor);
            let e = TimelineTime(
                fps.snap(base.0 + crate::time::ms_to_ticks(c.end_ms.clamp(0, DAY_MS))),
            );
            let e = if e.0 - s.0 < frame { s + frame } else { e };
            let text = c.text.trim();
            if text.is_empty() {
                continue;
            }
            drafts.push(CueDraft {
                start: s,
                duration: e - s,
                text: text.chars().take(500).collect(),
                speaker: None,
                source: None,
            });
            cursor = e;
        }
        if drafts.is_empty() {
            return Err(CommandError::conflict("The subtitle file contains no cues"));
        }
        let track = self
            .caption_track(track_id.filter(|t| self.track_kind(t) == Some(TrackKind::Caption)))?;
        let before = self.created.len();
        self.place_cues(&track, &drafts, false)?;
        Ok(self.created[before..].to_vec())
    }

    fn place_cues(&mut self, track: &str, cues: &[CueDraft], generated: bool) -> CmdResult<()> {
        let frame = self.frame();
        let none = BTreeSet::new();
        let mut placed: Vec<(TimelineTime, Ticks, &CueDraft)> = Vec::with_capacity(cues.len());
        for (i, cue) in cues.iter().enumerate() {
            let start = self.snap_time("cues.start", cue.start)?;
            let duration = self.snap(cue.duration).max(frame);
            if cue.text.trim().is_empty() {
                return Err(CommandError::invalid(
                    "cues.text",
                    format!("Caption {} has no text", i + 1),
                ));
            }
            check_text("cues.text", &cue.text, 500)?;
            placed.push((start, duration, cue));
        }
        placed.sort_by_key(|p| p.0);
        for i in 1..placed.len() {
            let prev_end = placed[i - 1].0 + placed[i - 1].1;
            if placed[i].0 < prev_end {
                // trim the earlier cue so cues never overlap
                let d = placed[i].0 - placed[i - 1].0;
                if d < frame {
                    return Err(CommandError::invalid("cues", "Captions overlap each other"));
                }
                placed[i - 1].1 = d;
            }
        }
        for (start, duration, cue) in placed {
            self.overwrite_range(track, start, start + duration, &none);
            self.new_clip(
                track,
                start,
                duration,
                SourceTime::ZERO,
                ClipContent::Caption {
                    text: cue.text.trim().to_string(),
                    speaker: cue.speaker.clone(),
                    source: cue.source.clone(),
                    generated,
                },
            );
        }
        Ok(())
    }

    fn add_text(
        &mut self,
        text: &str,
        start: TimelineTime,
        duration: Option<Ticks>,
        track_id: Option<&str>,
    ) -> CmdResult<String> {
        let text = check_text("text", text, 2000)?;
        if text.trim().is_empty() {
            return Err(CommandError::invalid("text", "Text must not be empty"));
        }
        let start = self.snap_time("start", start)?;
        let frame = self.frame();
        let duration = self
            .snap(duration.unwrap_or(DEFAULT_STILL_DURATION))
            .max(frame);
        if duration > MAX_TIMELINE_TICKS {
            return Err(CommandError::invalid("duration", "duration is too long"));
        }
        let track = match track_id {
            Some(t) => {
                let tr = self.unlocked_track(t)?;
                if tr.kind != TrackKind::Video {
                    return Err(CommandError::invalid(
                        "track_id",
                        "Text can only be placed on a video track",
                    ));
                }
                t.to_string()
            }
            None => {
                // First free, unlocked video track above V1; otherwise a new top track.
                let candidates: Vec<TrackId> = self
                    .p
                    .tracks_of_kind(TrackKind::Video)
                    .iter()
                    .skip(1)
                    .filter(|t| !t.locked)
                    .map(|t| t.id.clone())
                    .collect();
                let free = candidates.into_iter().find(|t| {
                    !self
                        .p
                        .clips
                        .values()
                        .any(|c| &c.track_id == t && c.overlaps(start, start + duration))
                });
                match free {
                    Some(t) => t,
                    None => self.add_track(TrackKind::Video, None)?,
                }
            }
        };
        let none = BTreeSet::new();
        self.overwrite_range(&track, start, start + duration, &none);
        self.new_clip(
            &track,
            start,
            duration,
            SourceTime::ZERO,
            ClipContent::Text {
                text,
                style: TextStyle::default(),
            },
        );
        Ok("Add text".into())
    }

    fn append_source_ranges(
        &mut self,
        asset_id: &str,
        ranges: &[SourceRange],
        at: Option<TimelineTime>,
    ) -> CmdResult<String> {
        if ranges.is_empty() {
            return Err(CommandError::invalid(
                "ranges",
                "Select at least one passage",
            ));
        }
        if ranges.len() > 2000 {
            return Err(CommandError::invalid("ranges", "Too many ranges"));
        }
        let asset = self
            .p
            .assets
            .get(asset_id)
            .cloned()
            .ok_or_else(|| CommandError::not_found("Asset", asset_id))?;
        if !matches!(asset.kind, AssetKind::Video | AssetKind::Audio) {
            return Err(CommandError::invalid(
                "asset_id",
                "Rough cuts need a video or audio asset",
            ));
        }
        for r in ranges {
            if r.start.0 < 0 || r.end <= r.start || r.end.0 > asset.duration + self.frame() {
                return Err(CommandError::invalid(
                    "ranges",
                    "A range lies outside the media",
                ));
            }
        }
        let mut cursor = match at {
            Some(t) => Some(self.snap_time("at", t)?),
            None => None,
        };
        for r in ranges {
            let mode = if cursor.is_some() {
                PlaceMode::Insert
            } else {
                PlaceMode::Overwrite
            };
            let ids =
                self.add_asset_clips(asset_id, cursor, None, Some(r.start), Some(r.end), mode)?;
            if let (Some(c), Some(id)) = (cursor.as_mut(), ids.first()) {
                *c = self.p.clips[id].end();
            }
        }
        Ok(format!(
            "Rough cut: add {} passage{}",
            ranges.len(),
            if ranges.len() == 1 { "" } else { "s" }
        ))
    }

    fn check_draft(&self, d: &ClipDraft) -> CmdResult<()> {
        let t = self.unlocked_track(&d.track_id)?;
        if t.kind != d.content.track_kind() {
            return Err(CommandError::invalid(
                "clips.track_id",
                format!(
                    "A {} clip cannot be placed on track {}",
                    d.content.kind_name(),
                    t.name
                ),
            ));
        }
        if d.duration <= 0 || d.duration > MAX_TIMELINE_TICKS {
            return Err(CommandError::invalid(
                "clips.duration",
                "Clip duration must be positive",
            ));
        }
        if Speed::new(d.speed.num, d.speed.den).is_none() {
            return Err(CommandError::invalid("clips.speed", "Invalid speed"));
        }
        if let Some(a) = d.content.asset_id() {
            let asset = self
                .p
                .assets
                .get(a)
                .ok_or_else(|| CommandError::not_found("Asset", a))?;
            let ok = match (&d.content, asset.kind) {
                (ClipContent::Video { .. }, AssetKind::Video) => asset.has_video,
                (ClipContent::Audio { .. }, AssetKind::Video | AssetKind::Audio) => asset.has_audio,
                (ClipContent::Image { .. }, AssetKind::Image) => true,
                _ => false,
            };
            if !ok {
                return Err(CommandError::invalid(
                    "clips.content",
                    "Clip content does not match its asset",
                ));
            }
            if d.content.is_timed_media()
                && (d.source_in.0 < 0 || d.source_in.0 >= asset.duration.max(1))
            {
                return Err(CommandError::invalid(
                    "clips.source_in",
                    "source_in is outside the media",
                ));
            }
        }
        match &d.content {
            ClipContent::Text { text, style } => {
                check_text("clips.text", text, 2000)?;
                validate_text_style(style)?;
            }
            ClipContent::Caption { text, .. } => {
                check_text("clips.text", text, 500)?;
            }
            _ => {}
        }
        validate_transform(&d.transform)?;
        validate_color(&d.color)?;
        check_finite("clips.gain_db", d.gain_db, -60.0, 24.0)?;
        Ok(())
    }

    fn insert_clips(
        &mut self,
        drafts: &[ClipDraft],
        at: TimelineTime,
        mode: PlaceMode,
    ) -> CmdResult<String> {
        if drafts.is_empty() {
            return Err(CommandError::invalid("clips", "Nothing to paste"));
        }
        if drafts.len() > 5000 {
            return Err(CommandError::invalid("clips", "Too many clips"));
        }
        let at = self.snap_time("at", at)?;
        let fps = self.fps();
        let frame = self.frame();
        let mut plan: Vec<(TimelineTime, Ticks, &ClipDraft)> = Vec::new();
        for d in drafts {
            self.check_draft(d)?;
            if d.offset < 0 || d.offset > MAX_TIMELINE_TICKS {
                return Err(CommandError::invalid(
                    "clips.offset",
                    "offset must be between 0 and the maximum timeline length",
                ));
            }
            let start = TimelineTime(fps.snap(at.0 + d.offset));
            let mut duration = fps.snap(d.duration).max(frame);
            if let (true, Some(asset)) = (
                d.content.is_timed_media(),
                d.content.asset_id().and_then(|a| self.p.assets.get(a)),
            ) {
                let max = fps
                    .snap_floor(d.speed.source_to_output(asset.duration - d.source_in.0))
                    .max(frame);
                duration = duration.min(max);
            }
            plan.push((start, duration, d));
        }
        // pasted clips must not overlap each other
        let mut by_track: BTreeMap<&str, Vec<(TimelineTime, TimelineTime)>> = BTreeMap::new();
        for (s, d, draft) in &plan {
            by_track
                .entry(draft.track_id.as_str())
                .or_default()
                .push((*s, *s + *d));
        }
        for v in by_track.values_mut() {
            v.sort();
            if v.windows(2).any(|w| w[1].0 < w[0].1) {
                return Err(CommandError::invalid(
                    "clips",
                    "Pasted clips overlap each other",
                ));
            }
        }
        let none = BTreeSet::new();
        let extent_end = plan.iter().map(|(s, d, _)| (*s + *d).0).max().unwrap();
        match mode {
            PlaceMode::Insert => {
                self.split_all_at(at);
                self.shift_from(at, extent_end - at.0, &none);
            }
            PlaceMode::Overwrite => {
                for (s, d, draft) in &plan {
                    self.overwrite_range(&draft.track_id, *s, *s + *d, &none);
                }
            }
        }
        let mut links: BTreeMap<String, String> = BTreeMap::new();
        let mut groups: BTreeMap<String, String> = BTreeMap::new();
        for (s, dur, d) in plan {
            let id = self.new_clip(&d.track_id, s, dur, d.source_in, d.content.clone());
            let link_id = match &d.link_key {
                Some(k) => Some(match links.get(k) {
                    Some(v) => v.clone(),
                    None => {
                        let v = self.p.gen_id("l");
                        links.insert(k.clone(), v.clone());
                        v
                    }
                }),
                None => None,
            };
            let group_id = match &d.group_key {
                Some(k) => Some(match groups.get(k) {
                    Some(v) => v.clone(),
                    None => {
                        let v = self.p.gen_id("g");
                        groups.insert(k.clone(), v.clone());
                        v
                    }
                }),
                None => None,
            };
            let c = self.p.clips.get_mut(&id).unwrap();
            c.speed = Speed::new(d.speed.num, d.speed.den).unwrap();
            c.enabled = d.enabled;
            c.transform = d.transform;
            c.color = d.color;
            c.gain_db = d.gain_db;
            c.fade_in = d.fade_in.max(0);
            c.fade_out = d.fade_out.max(0);
            c.link_id = link_id;
            c.group_id = group_id;
        }
        Ok(if drafts.len() == 1 {
            "Paste clip".into()
        } else {
            format!("Paste {} clips", drafts.len())
        })
    }

    fn duplicate_clips(&mut self, clip_ids: &[ClipId]) -> CmdResult<String> {
        let ids = self.editable_clips(clip_ids)?;
        let clips: Vec<Clip> = ids.iter().map(|id| self.p.clips[id].clone()).collect();
        let sel_start = clips.iter().map(|c| c.start).min().unwrap();
        let sel_end = clips.iter().map(|c| c.end()).max().unwrap();
        // earliest position at or after the selection where every copy fits
        let mut t0 = sel_end;
        for _ in 0..10_000 {
            let mut bump: Option<TimelineTime> = None;
            for c in &clips {
                let s = t0 + (c.start - sel_start);
                let e = s + c.duration;
                for other in self
                    .p
                    .clips
                    .values()
                    .filter(|o| o.track_id == c.track_id && o.overlaps(s, e))
                {
                    let need = other.end() - (c.start - sel_start);
                    bump = Some(bump.map_or(need, |b: TimelineTime| b.max(need)));
                }
            }
            match bump {
                Some(b) if b > t0 => t0 = b,
                _ => break,
            }
        }
        let drafts: Vec<ClipDraft> = clips
            .iter()
            .map(|c| ClipDraft {
                track_id: c.track_id.clone(),
                offset: c.start - sel_start,
                duration: c.duration,
                source_in: c.source_in,
                speed: c.speed,
                content: c.content.clone(),
                enabled: c.enabled,
                transform: c.transform,
                color: c.color,
                gain_db: c.gain_db,
                fade_in: c.fade_in,
                fade_out: c.fade_out,
                link_key: c.link_id.clone(),
                group_key: c.group_id.clone(),
            })
            .collect();
        self.insert_clips(&drafts, t0, PlaceMode::Overwrite)?;
        Ok(if ids.len() == 1 {
            "Duplicate clip".into()
        } else {
            format!("Duplicate {} clips", ids.len())
        })
    }

    // -------------------------------------------------------------------------
    // arranging
    // -------------------------------------------------------------------------
    fn move_clips(&mut self, moves: &[ClipMove], mode: PlaceMode) -> CmdResult<String> {
        if moves.is_empty() {
            return Err(CommandError::invalid("moves", "Select at least one clip"));
        }
        let mut seen = BTreeSet::new();
        let mut plan: Vec<(ClipId, TimelineTime, TrackId)> = Vec::new();
        for m in moves {
            if !seen.insert(m.clip_id.clone()) {
                return Err(CommandError::invalid("moves", "A clip is listed twice"));
            }
            let c = self.clip(&m.clip_id)?.clone();
            self.unlocked_track(&c.track_id)?;
            let target = self.unlocked_track(&m.track_id)?;
            if target.kind != c.content.track_kind() {
                return Err(CommandError::invalid(
                    "moves.track_id",
                    format!(
                        "A {} clip cannot be moved to track {}",
                        c.content.kind_name(),
                        target.name
                    ),
                ));
            }
            let start = self.snap_time("moves.start", m.start)?;
            plan.push((c.id.clone(), start, m.track_id.clone()));
        }
        if plan.iter().all(|(id, s, t)| {
            let c = &self.p.clips[id];
            c.start == *s && &c.track_id == t
        }) {
            return Err(CommandError::conflict(
                "The clips are already at that position",
            ));
        }
        let moving: BTreeSet<ClipId> = plan.iter().map(|p| p.0.clone()).collect();
        let none = BTreeSet::new();
        {
            // moved clips must not collide with each other
            let mut by_track: BTreeMap<&str, Vec<(TimelineTime, TimelineTime)>> = BTreeMap::new();
            for (id, s, t) in &plan {
                by_track
                    .entry(t.as_str())
                    .or_default()
                    .push((*s, *s + self.p.clips[id].duration));
            }
            for v in by_track.values_mut() {
                v.sort();
                if v.windows(2).any(|w| w[1].0 < w[0].1) {
                    return Err(CommandError::conflict(
                        "The moved clips would overlap each other",
                    ));
                }
            }
        }

        if mode == PlaceMode::Insert {
            // Shuffle edit: extract the selection (closing its gap), then ripple-insert it.
            let old_start = moving
                .iter()
                .map(|id| self.p.clips[id].start)
                .min()
                .unwrap();
            let old_end = moving
                .iter()
                .map(|id| self.p.clips[id].end())
                .max()
                .unwrap();
            let new_start = plan.iter().map(|p| p.1).min().unwrap();
            let held: Vec<Clip> = moving
                .iter()
                .map(|id| self.p.clips.remove(id).unwrap())
                .collect();
            let closed = self.ripple_close(old_start, old_end);
            let mut t = new_start;
            if new_start > old_start {
                t = TimelineTime((new_start.0 - closed).max(old_start.0));
            }
            let len = plan
                .iter()
                .map(|(id, s, _)| {
                    (*s - new_start) + held.iter().find(|c| &c.id == id).unwrap().duration
                })
                .max()
                .unwrap();
            self.split_all_at(t);
            self.shift_from(t, len, &none);
            for mut c in held {
                let (_, s, track) = plan.iter().find(|p| p.0 == c.id).unwrap();
                c.start = t + (*s - new_start);
                c.track_id = track.clone();
                self.p.clips.insert(c.id.clone(), c);
            }
        } else {
            for (id, s, t) in &plan {
                let d = self.p.clips[id].duration;
                self.overwrite_range(t, *s, *s + d, &moving);
            }
            for (id, s, t) in &plan {
                let c = self.p.clips.get_mut(id).unwrap();
                c.start = *s;
                c.track_id = t.clone();
            }
        }
        Ok(if plan.len() == 1 {
            "Move clip".into()
        } else {
            format!("Move {} clips", plan.len())
        })
    }

    fn trim_clips(
        &mut self,
        clip_ids: &[ClipId],
        edge: Edge,
        delta: Ticks,
        ripple: bool,
    ) -> CmdResult<String> {
        let ids = self.editable_clips(clip_ids)?;
        let fps = self.fps();
        let frame = self.frame();
        let set: BTreeSet<ClipId> = ids.iter().cloned().collect();
        let (mut lo, mut hi) = (i64::MIN, i64::MAX);
        for id in &ids {
            let c = &self.p.clips[id];
            let asset_dur = self.asset_duration_of(c);
            let spans = self.spans(&c.track_id);
            match edge {
                Edge::End => {
                    lo = lo.max(-(c.duration - frame));
                    if let Some(ad) = asset_dur {
                        let max_dur = fps
                            .snap_floor(c.speed.source_to_output(ad - c.source_in.0))
                            .max(c.duration);
                        hi = hi.min(max_dur - c.duration);
                    }
                    if !ripple {
                        // (other selected clips are neighbours too: only this edge of them moves)
                        if let Some(next) = spans.iter().find(|s| s.0 >= c.end()) {
                            hi = hi.min(next.0 - c.end());
                        }
                    }
                    hi = hi.min(MAX_TIMELINE_TICKS - c.end().0);
                }
                Edge::Start => {
                    hi = hi.min(c.duration - frame);
                    if asset_dur.is_some() {
                        let max_ext = fps.snap_floor(c.speed.source_to_output(c.source_in.0));
                        lo = lo.max(-max_ext);
                    }
                    if !ripple {
                        let prev_end = spans
                            .iter()
                            .filter(|s| s.1 <= c.start)
                            .map(|s| s.1)
                            .max()
                            .unwrap_or(TimelineTime::ZERO);
                        lo = lo.max(prev_end - c.start);
                    } else {
                        lo = lo.max(-(MAX_TIMELINE_TICKS - c.end().0));
                    }
                }
            }
        }
        let d = if lo > hi {
            0
        } else {
            self.snap(delta).clamp(lo, hi)
        };
        if d == 0 {
            return Err(CommandError::conflict(match (edge, delta > 0) {
                (Edge::End, true) | (Edge::Start, false) => "Cannot extend the clip any further: it has reached the end of its source media or an adjacent clip.",
                _ => "Cannot trim any further: a clip must be at least one frame long.",
            }));
        }
        if !ripple {
            for id in &ids {
                let c = self.p.clips.get_mut(id).unwrap();
                match edge {
                    Edge::End => c.duration += d,
                    Edge::Start => {
                        if c.content.is_timed_media() {
                            c.source_in += c.speed.output_to_source(d);
                        }
                        c.start += d;
                        c.duration -= d;
                    }
                }
            }
            return Ok("Trim clip".into());
        }
        // Ripple trim: all clips must share the edit point's far side so one shift fits all.
        let old_end = self.p.clips[&ids[0]].end();
        if ids.iter().any(|id| self.p.clips[id].end() != old_end) {
            return Err(CommandError::conflict("Ripple trim needs clips that end at the same point (for example a linked video/audio pair)."));
        }
        // change in clip length
        let grow = match edge {
            Edge::End => d,
            Edge::Start => -d,
        };
        for id in &ids {
            let c = self.p.clips.get_mut(id).unwrap();
            if edge == Edge::Start && c.content.is_timed_media() {
                c.source_in += c.speed.output_to_source(d);
            }
            c.duration += grow;
        }
        if grow > 0 {
            // push later material right; the trimmed clips themselves stay put
            self.shift_from(old_end, grow, &set);
        } else {
            let closed = self.ripple_close(old_end + grow, old_end);
            if closed < -grow {
                self.notices.push("The gap could not be closed completely because clips on other tracks are in the way.".into());
            }
        }
        Ok("Ripple trim".into())
    }

    fn slip_clips(&mut self, clip_ids: &[ClipId], delta: Ticks) -> CmdResult<String> {
        let ids = self.editable_clips(clip_ids)?;
        let (mut lo, mut hi) = (i64::MIN, i64::MAX);
        for id in &ids {
            let c = &self.p.clips[id];
            let ad = self.asset_duration_of(c).ok_or_else(|| {
                CommandError::conflict("Only video and audio clips can be slipped")
            })?;
            lo = lo.max(-c.source_in.0);
            hi = hi.min((ad - c.source_out().0).max(0));
        }
        let d = if lo > hi { 0 } else { delta.clamp(lo, hi) };
        if d == 0 {
            return Err(CommandError::conflict(
                "No spare source media to slip in that direction",
            ));
        }
        for id in &ids {
            self.p.clips.get_mut(id).unwrap().source_in += d;
        }
        Ok("Slip clip".into())
    }

    fn split_clips(&mut self, at: TimelineTime, clip_ids: Option<&[ClipId]>) -> CmdResult<String> {
        let t = self.snap_time("at", at)?;
        let targets: Vec<ClipId> = match clip_ids {
            Some(ids) => {
                let ids = self.editable_clips(ids)?;
                ids.into_iter()
                    .filter(|id| {
                        let c = &self.p.clips[id];
                        c.start < t && c.end() > t
                    })
                    .collect()
            }
            None => self
                .p
                .clips
                .values()
                .filter(|c| c.start < t && c.end() > t && !self.is_locked(&c.track_id))
                .map(|c| c.id.clone())
                .collect(),
        };
        if targets.is_empty() {
            return Err(CommandError::conflict(
                "There is no clip to split at this position. Move the playhead inside a clip.",
            ));
        }
        let mut pairs = Vec::new();
        for id in targets {
            let r = self.split_one(&id, t);
            self.created.push(r.clone());
            pairs.push((id, r));
        }
        self.relink_split(&pairs);
        Ok("Split".into())
    }

    fn delete_clips(&mut self, clip_ids: &[ClipId], ripple: bool) -> CmdResult<String> {
        let ids = self.editable_clips(clip_ids)?;
        let intervals: Vec<(TimelineTime, TimelineTime)> = ids
            .iter()
            .map(|id| {
                let c = &self.p.clips[id];
                (c.start, c.end())
            })
            .collect();
        for id in &ids {
            self.p.clips.remove(id);
        }
        let n = ids.len();
        if !ripple {
            return Ok(if n == 1 {
                "Delete clip".into()
            } else {
                format!("Delete {n} clips")
            });
        }
        let mut partial = false;
        for (s, e) in Self::merged_intervals(intervals).into_iter().rev() {
            let closed = self.ripple_close(s, e);
            if closed < e - s {
                partial = true;
            }
        }
        if partial {
            self.notices.push("Some gaps could not be closed completely because clips on other tracks are in the way.".into());
        }
        Ok(if n == 1 {
            "Ripple delete clip".into()
        } else {
            format!("Ripple delete {n} clips")
        })
    }

    fn close_gap(&mut self, track_id: &str, at: TimelineTime) -> CmdResult<String> {
        self.unlocked_track(track_id)?;
        let spans = self.spans(track_id);
        if spans.iter().any(|s| s.0 <= at && s.1 > at) {
            return Err(CommandError::conflict("There is no gap at this position"));
        }
        let s = spans
            .iter()
            .filter(|x| x.1 <= at)
            .map(|x| x.1)
            .max()
            .unwrap_or(TimelineTime::ZERO);
        let e = spans
            .iter()
            .filter(|x| x.0 > at)
            .map(|x| x.0)
            .min()
            .ok_or_else(|| {
                CommandError::conflict("There is nothing after this position to pull in")
            })?;
        let closed = self.ripple_close(s, e);
        if closed == 0 {
            return Err(CommandError::conflict(
                "The gap cannot be closed because clips on other tracks are in the way.",
            ));
        }
        if closed < e - s {
            self.notices.push("The gap could only be closed partially because clips on other tracks are in the way.".into());
        }
        Ok("Close gap".into())
    }

    fn update_clips(&mut self, clip_ids: &[ClipId], patch: &ClipPatch) -> CmdResult<String> {
        let ids = self.editable_clips(clip_ids)?;
        if *patch == ClipPatch::default() {
            return Err(CommandError::invalid("patch", "Nothing to change"));
        }
        let visual_fields = patch.x.is_some()
            || patch.y.is_some()
            || patch.scale.is_some()
            || patch.rotation.is_some()
            || patch.opacity.is_some()
            || patch.crop_left.is_some()
            || patch.crop_top.is_some()
            || patch.crop_right.is_some()
            || patch.crop_bottom.is_some()
            || patch.flip_h.is_some()
            || patch.flip_v.is_some();
        let color_fields = patch.brightness.is_some()
            || patch.contrast.is_some()
            || patch.saturation.is_some()
            || patch.temperature.is_some();
        let style_fields = patch.font_size.is_some()
            || patch.text_color.is_some()
            || patch.bold.is_some()
            || patch.align.is_some()
            || patch.background.is_some()
            || patch.outline_color.is_some()
            || patch.outline_width.is_some()
            || patch.shadow.is_some();
        let (
            mut any_visual,
            mut any_color,
            mut any_audio,
            mut any_text,
            mut any_style,
            mut any_caption,
        ) = (false, false, false, false, false, false);
        let fps = self.fps();
        for id in &ids {
            let mut c = self.p.clips[id].clone();
            let is_caption = matches!(c.content, ClipContent::Caption { .. });
            let is_audio = matches!(c.content, ClipContent::Audio { .. });
            let is_picture = matches!(
                c.content,
                ClipContent::Video { .. } | ClipContent::Image { .. }
            );
            if !is_audio && !is_caption {
                any_visual = true;
                let t = &mut c.transform;
                if let Some(v) = patch.x {
                    t.x = v;
                }
                if let Some(v) = patch.y {
                    t.y = v;
                }
                if let Some(v) = patch.scale {
                    t.scale = v;
                }
                if let Some(v) = patch.rotation {
                    t.rotation = v;
                }
                if let Some(v) = patch.opacity {
                    t.opacity = v;
                }
                if let Some(v) = patch.flip_h {
                    t.flip_h = v;
                }
                if let Some(v) = patch.flip_v {
                    t.flip_v = v;
                }
                if is_picture {
                    if let Some(v) = patch.crop_left {
                        t.crop.left = v;
                    }
                    if let Some(v) = patch.crop_top {
                        t.crop.top = v;
                    }
                    if let Some(v) = patch.crop_right {
                        t.crop.right = v;
                    }
                    if let Some(v) = patch.crop_bottom {
                        t.crop.bottom = v;
                    }
                }
                validate_transform(&c.transform)?;
            }
            if is_picture {
                any_color = true;
                if let Some(v) = patch.brightness {
                    c.color.brightness = v;
                }
                if let Some(v) = patch.contrast {
                    c.color.contrast = v;
                }
                if let Some(v) = patch.saturation {
                    c.color.saturation = v;
                }
                if let Some(v) = patch.temperature {
                    c.color.temperature = v;
                }
                validate_color(&c.color)?;
            }
            if is_audio {
                any_audio = true;
                if let Some(v) = patch.gain_db {
                    c.gain_db = check_finite("gain_db", v, -60.0, 24.0)?;
                }
            }
            if !is_caption {
                if let Some(v) = patch.fade_in {
                    if v < 0 {
                        return Err(CommandError::invalid(
                            "fade_in",
                            "fade_in must not be negative",
                        ));
                    }
                    c.fade_in = fps.snap(v.min(c.duration));
                }
                if let Some(v) = patch.fade_out {
                    if v < 0 {
                        return Err(CommandError::invalid(
                            "fade_out",
                            "fade_out must not be negative",
                        ));
                    }
                    c.fade_out = fps.snap(v.min(c.duration));
                }
                if patch.fade_in.is_some() && patch.fade_out.is_none() {
                    c.fade_out = c.fade_out.min(c.duration - c.fade_in);
                } else {
                    c.fade_in = c.fade_in.min(c.duration - c.fade_out);
                }
            }
            if let Some(v) = patch.enabled {
                c.enabled = v;
            }
            match &mut c.content {
                ClipContent::Text { text, style } => {
                    any_text = true;
                    any_style = true;
                    if let Some(t) = &patch.text {
                        let t = check_text("text", t, 2000)?;
                        if t.trim().is_empty() {
                            return Err(CommandError::invalid("text", "Text must not be empty"));
                        }
                        *text = t;
                    }
                    if let Some(v) = patch.font_size {
                        style.font_size = v;
                    }
                    if let Some(v) = &patch.text_color {
                        style.color = check_color("text_color", v, false)?;
                    }
                    if let Some(v) = patch.bold {
                        style.bold = v;
                    }
                    if let Some(v) = patch.align {
                        style.align = v;
                    }
                    if let Some(v) = &patch.background {
                        style.background = match v {
                            Some(c) => Some(check_color("background", c, true)?),
                            None => None,
                        };
                    }
                    if let Some(v) = &patch.outline_color {
                        style.outline_color = check_color("outline_color", v, false)?;
                    }
                    if let Some(v) = patch.outline_width {
                        style.outline_width = v;
                    }
                    if let Some(v) = patch.shadow {
                        style.shadow = v;
                    }
                    validate_text_style(style)?;
                }
                ClipContent::Caption {
                    text,
                    speaker,
                    generated,
                    ..
                } => {
                    any_text = true;
                    any_caption = true;
                    if let Some(t) = &patch.text {
                        let t = check_text("text", t, 500)?;
                        if t.trim().is_empty() {
                            return Err(CommandError::invalid(
                                "text",
                                "Caption text must not be empty",
                            ));
                        }
                        if *text != t {
                            // an edited caption is the user's own and survives regeneration
                            *generated = false;
                        }
                        *text = t;
                    }
                    if let Some(s) = &patch.speaker {
                        *speaker = s.clone().filter(|s| !s.trim().is_empty());
                    }
                }
                _ => {}
            }
            self.p.clips.insert(id.clone(), c);
        }
        if visual_fields && !any_visual {
            return Err(CommandError::invalid("patch", "Position, scale, rotation, crop and opacity only apply to video, image and text clips"));
        }
        if color_fields && !any_color {
            return Err(CommandError::invalid(
                "patch",
                "Colour controls only apply to video and image clips",
            ));
        }
        if patch.gain_db.is_some() && !any_audio {
            return Err(CommandError::invalid(
                "gain_db",
                "Volume only applies to audio clips",
            ));
        }
        if patch.text.is_some() && !any_text {
            return Err(CommandError::invalid(
                "text",
                "Only text and caption clips have text",
            ));
        }
        if style_fields && !any_style {
            return Err(CommandError::invalid(
                "patch",
                "Text style only applies to text clips. Caption style is a project setting.",
            ));
        }
        if patch.speaker.is_some() && !any_caption {
            return Err(CommandError::invalid(
                "speaker",
                "Only captions have a speaker label",
            ));
        }
        Ok("Edit clip".into())
    }

    fn set_speed(&mut self, clip_ids: &[ClipId], speed: f64, ripple: bool) -> CmdResult<String> {
        let ids = self.editable_clips(clip_ids)?;
        let new_speed = Speed::from_f64(speed).ok_or_else(|| {
            CommandError::invalid(
                "speed",
                format!("Speed must be between {}× and {}×", Speed::MIN, Speed::MAX),
            )
        })?;
        let fps = self.fps();
        let frame = self.frame();
        for id in &ids {
            if !self.p.clips[id].content.is_timed_media() {
                return Err(CommandError::conflict(
                    "Speed can only be changed on video and audio clips",
                ));
            }
        }
        // Process from the last clip backwards so ripples do not disturb pending clips.
        let mut order = ids.clone();
        order.sort_by_key(|id| std::cmp::Reverse(self.p.clips[id].start));
        // Linked clips at the same position are changed together with one ripple.
        let mut done: BTreeSet<ClipId> = BTreeSet::new();
        for id in order {
            if done.contains(&id) {
                continue;
            }
            let (start, old_end) = {
                let c = &self.p.clips[&id];
                (c.start, c.end())
            };
            let batch: Vec<ClipId> = ids
                .iter()
                .filter(|i| {
                    !done.contains(*i)
                        && self.p.clips[*i].start == start
                        && self.p.clips[*i].end() == old_end
                })
                .cloned()
                .collect();
            // Only the clips changed in this step are exempt from neighbour limits and
            // ripples; other selected clips are ordinary neighbours here.
            let batch_set: BTreeSet<ClipId> = batch.iter().cloned().collect();
            let mut new_dur_max = 0;
            for b in &batch {
                let c = &self.p.clips[b];
                // The shown source range is preserved, but never beyond the media:
                // frame rounding at a high speed can overshoot the end by a few
                // source frames, which must not be carried into a slower speed.
                let mut src = c.source_duration();
                if let Some(ad) = self.asset_duration_of(c) {
                    src = src.min((ad - c.source_in.0).max(1));
                }
                let mut nd = fps.snap(new_speed.source_to_output(src)).max(frame);
                if !ripple {
                    // stay inside the free space up to the next clip
                    let next = self
                        .spans(&c.track_id)
                        .into_iter()
                        .find(|s| s.0 >= c.end() && !batch_set.contains(&s.2))
                        .map(|s| s.0);
                    if let Some(n) = next {
                        nd = nd.min(n - c.start);
                    }
                }
                new_dur_max = new_dur_max.max(nd);
                let c = self.p.clips.get_mut(b).unwrap();
                c.speed = new_speed;
                c.duration = nd;
                done.insert(b.clone());
            }
            if ripple {
                let old_dur = old_end - start;
                if new_dur_max > old_dur {
                    self.shift_from(old_end, new_dur_max - old_dur, &batch_set);
                } else if new_dur_max < old_dur {
                    let closed = self.ripple_close(start + new_dur_max, old_end);
                    if closed < old_end - (start + new_dur_max) {
                        self.notices.push("The gap after the faster clip could not be closed completely because clips on other tracks are in the way.".into());
                    }
                }
            }
        }
        Ok(format!(
            "Change speed to {}×",
            trim_float(new_speed.as_f64())
        ))
    }

    // -------------------------------------------------------------------------
    // transitions
    // -------------------------------------------------------------------------
    fn transition_limit(&self, left: &Clip, right: &Clip, ignore: Option<&str>) -> Ticks {
        // Half of the transition lives in each clip; leave room for the transition
        // on the other side of each clip.
        let other_in = self
            .p
            .transitions
            .values()
            .filter(|t| t.right == left.id && Some(t.id.as_str()) != ignore)
            .map(|t| t.duration / 2)
            .max()
            .unwrap_or(0);
        let other_out = self
            .p
            .transitions
            .values()
            .filter(|t| t.left == right.id && Some(t.id.as_str()) != ignore)
            .map(|t| t.duration / 2)
            .max()
            .unwrap_or(0);
        let half = (left.duration - other_in).min(right.duration - other_out);
        even_frames(
            self.fps(),
            half.saturating_mul(2)
                .min(left.duration.min(right.duration)),
        )
    }

    fn add_transitions(
        &mut self,
        left_ids: &[ClipId],
        kind: TransitionKind,
        duration: Ticks,
    ) -> CmdResult<String> {
        let ids = self.editable_clips(left_ids)?;
        let fps = self.fps();
        let min = 2 * self.frame();
        if duration <= 0 {
            return Err(CommandError::invalid(
                "duration",
                "Transition duration must be positive",
            ));
        }
        for id in &ids {
            let left = self.p.clips[id].clone();
            let track = self.track(&left.track_id)?.clone();
            if track.kind == TrackKind::Caption {
                return Err(CommandError::conflict(
                    "Captions do not support transitions",
                ));
            }
            let right = self
                .p
                .clips
                .values()
                .find(|c| c.track_id == left.track_id && c.start == left.end())
                .cloned()
                .ok_or_else(|| CommandError::conflict("A transition needs two clips that touch. There is no clip directly after the selected one."))?;
            let existing: Vec<TransitionId> = self
                .p
                .transitions
                .values()
                .filter(|t| t.left == left.id || t.right == right.id)
                .map(|t| t.id.clone())
                .collect();
            for e in existing {
                self.p.transitions.remove(&e);
            }
            let limit = self.transition_limit(&left, &right, None);
            let d = even_frames(fps, duration).min(limit);
            if d < min {
                return Err(CommandError::conflict(
                    "The clips are too short for a transition here",
                ));
            }
            let kind = if track.kind == TrackKind::Audio {
                TransitionKind::CrossDissolve
            } else {
                kind
            };
            let tid = self.p.gen_id("x");
            self.p.transitions.insert(
                tid.clone(),
                Transition {
                    id: tid,
                    kind,
                    left: left.id.clone(),
                    right: right.id.clone(),
                    duration: d,
                },
            );
        }
        Ok("Add transition".into())
    }

    fn update_transition(
        &mut self,
        id: &str,
        kind: Option<TransitionKind>,
        duration: Option<Ticks>,
    ) -> CmdResult<String> {
        let tr = self
            .p
            .transitions
            .get(id)
            .cloned()
            .ok_or_else(|| CommandError::not_found("Transition", id))?;
        let left = self.clip(&tr.left)?.clone();
        let right = self.clip(&tr.right)?.clone();
        let track = self.unlocked_track(&left.track_id)?.clone();
        let mut new = tr.clone();
        if let Some(k) = kind {
            new.kind = if track.kind == TrackKind::Audio {
                TransitionKind::CrossDissolve
            } else {
                k
            };
        }
        if let Some(d) = duration {
            if d <= 0 {
                return Err(CommandError::invalid(
                    "duration",
                    "Transition duration must be positive",
                ));
            }
            let limit = self.transition_limit(&left, &right, Some(id));
            new.duration = even_frames(self.fps(), d).min(limit).max(2 * self.frame());
            if new.duration > limit {
                return Err(CommandError::conflict(
                    "The clips are too short for a transition here",
                ));
            }
        }
        self.p.transitions.insert(id.to_string(), new);
        Ok("Edit transition".into())
    }

    // -------------------------------------------------------------------------
    // transcript editing
    // -------------------------------------------------------------------------
    fn correct_word(
        &mut self,
        asset_id: &str,
        word_index: u32,
        text: Option<&str>,
    ) -> CmdResult<String> {
        if !self.p.assets.contains_key(asset_id) {
            return Err(CommandError::not_found("Asset", asset_id));
        }
        let transcript =
            self.env.transcripts.get(asset_id).ok_or_else(|| {
                CommandError::conflict("This media has no completed transcript yet")
            })?;
        let word = transcript.words.get(word_index as usize).ok_or_else(|| {
            CommandError::invalid("word_index", "That word does not exist in the transcript")
        })?;
        let new = match text.map(str::trim) {
            Some(t) if !t.is_empty() && t != word.text => {
                let t = check_text("text", t, 120)?;
                if t.contains('\n') {
                    return Err(CommandError::invalid(
                        "text",
                        "A corrected word must be a single line",
                    ));
                }
                Some(t)
            }
            _ => None,
        };
        match new {
            Some(t) => {
                self.p
                    .transcript
                    .corrections
                    .entry(asset_id.to_string())
                    .or_default()
                    .insert(word_index, t);
                Ok("Correct transcript".into())
            }
            None => {
                let existed = match self.p.transcript.corrections.get_mut(asset_id) {
                    Some(m) => {
                        let e = m.remove(&word_index).is_some();
                        if m.is_empty() {
                            self.p.transcript.corrections.remove(asset_id);
                        }
                        e
                    }
                    None => false,
                };
                if !existed {
                    return Err(CommandError::conflict(
                        "The word already shows its original text",
                    ));
                }
                Ok("Revert transcript correction".into())
            }
        }
    }

    fn ripple_delete_source(
        &mut self,
        cuts: &[SourceCut],
        reason: RemovalReason,
    ) -> CmdResult<String> {
        if cuts.is_empty() {
            return Err(CommandError::invalid("cuts", "Nothing selected to remove"));
        }
        if cuts.len() > 20_000 {
            return Err(CommandError::invalid("cuts", "Too many cuts in one edit"));
        }
        let fps = self.fps();
        let frame = self.frame();
        // Resolve every cut to a timeline range inside its clip.
        struct Planned {
            clip_id: ClipId,
            asset_id: AssetId,
            tl: (TimelineTime, TimelineTime),
            src: (SourceTime, SourceTime),
            text: String,
        }
        let mut planned: Vec<Planned> = Vec::new();
        for cut in cuts {
            let c = self.clip(&cut.clip_id)?.clone();
            self.unlocked_track(&c.track_id)?;
            let asset_id = match (c.content.is_timed_media(), c.asset_id()) {
                (true, Some(a)) => a.to_string(),
                _ => {
                    return Err(CommandError::invalid(
                        "cuts.clip_id",
                        "Transcript edits need a video or audio clip",
                    ))
                }
            };
            if cut.source_end <= cut.source_start {
                return Err(CommandError::invalid(
                    "cuts",
                    "A cut must end after it starts",
                ));
            }
            let s = cut.source_start.max(c.source_in);
            let e = cut.source_end.min(c.source_out());
            if e <= s {
                return Err(CommandError::conflict("The selected words are no longer on the timeline (the clip was trimmed). Refresh the transcript and try again."));
            }
            let mut ts = TimelineTime(fps.snap(c.timeline_time_of(s).0)).max(c.start);
            let mut te = TimelineTime(fps.snap(c.timeline_time_of(e).0)).min(c.end());
            if te <= ts {
                // shorter than a frame: remove the single frame containing it
                ts = TimelineTime(fps.snap_floor(c.timeline_time_of(s).0)).max(c.start);
                te = (ts + frame).min(c.end());
                if te <= ts {
                    continue;
                }
            }
            planned.push(Planned {
                clip_id: c.id.clone(),
                asset_id,
                tl: (ts, te),
                src: (s, e),
                text: cut.text.trim().to_string(),
            });
        }
        if planned.is_empty() {
            return Err(CommandError::conflict(
                "The selection is shorter than one frame; nothing was removed.",
            ));
        }
        // Merge touching ranges of the same clip so adjacent words become one cut.
        planned.sort_by_key(|p| (p.clip_id.clone(), p.tl.0));
        let mut merged: Vec<Planned> = Vec::new();
        for p in planned {
            match merged.last_mut() {
                Some(last) if last.clip_id == p.clip_id && p.tl.0 <= last.tl.1 => {
                    last.tl.1 = last.tl.1.max(p.tl.1);
                    last.src.1 = last.src.1.max(p.src.1);
                    if !p.text.is_empty() {
                        if !last.text.is_empty() {
                            last.text.push(' ');
                        }
                        last.text.push_str(&p.text);
                    }
                }
                _ => merged.push(p),
            }
        }
        // Later ranges first: earlier material never moves, so earlier ranges stay valid.
        merged.sort_by_key(|p| std::cmp::Reverse(p.tl.0));
        let mut removed_total: Ticks = 0;
        let mut partial = false;
        let count = merged.len();
        for m in merged {
            let Some(primary) = self.p.clips.get(&m.clip_id).cloned() else {
                continue;
            };
            let (ts, te) = (m.tl.0.max(primary.start), m.tl.1.min(primary.end()));
            if te <= ts {
                continue;
            }
            // the clip itself plus its linked companions (unlocked) covering the range
            let mut targets: Vec<ClipId> = vec![primary.id.clone()];
            if let Some(link) = &primary.link_id {
                for c in self.p.clips.values() {
                    if c.id != primary.id
                        && c.link_id.as_ref() == Some(link)
                        && c.overlaps(ts, te)
                        && !self.is_locked(&c.track_id)
                    {
                        targets.push(c.id.clone());
                    }
                }
            }
            let mut doomed: Vec<ClipId> = Vec::new();
            let mut pairs_end: Vec<(ClipId, ClipId)> = Vec::new();
            for id in &targets {
                let c = self.p.clips[id].clone();
                let (cs, ce) = (ts.max(c.start), te.min(c.end()));
                if ce <= cs {
                    continue;
                }
                // split off the part before the range
                let mut mid = id.clone();
                if cs > c.start {
                    mid = self.split_one(id, cs);
                }
                // split off the part after the range
                if ce < c.end() {
                    let tail = self.split_one(&mid, ce);
                    pairs_end.push((mid.clone(), tail));
                }
                doomed.push(mid);
            }
            // keep A/V links consistent on both sides of the cut
            self.relink_split(&pairs_end);
            for id in &doomed {
                self.p.clips.remove(id);
            }
            let closed = self.ripple_close(ts, te);
            if closed < te - ts {
                partial = true;
            }
            removed_total += te - ts;
            let trace_id = self.p.gen_id("r");
            let revision = self.p.revision;
            self.p.transcript.removals.push(RemovalTrace {
                id: trace_id,
                asset_id: m.asset_id,
                clip_id: m.clip_id,
                source_start: m.src.0,
                source_end: m.src.1,
                timeline_start: ts,
                timeline_end: te,
                reason,
                text: m.text.chars().take(400).collect(),
                revision,
            });
        }
        if removed_total == 0 {
            return Err(CommandError::conflict("Nothing was removed"));
        }
        const MAX_TRACE: usize = 5000;
        if self.p.transcript.removals.len() > MAX_TRACE {
            let drop = self.p.transcript.removals.len() - MAX_TRACE;
            self.p.transcript.removals.drain(0..drop);
        }
        if partial {
            self.notices.push("Some gaps could not be closed completely because clips on other tracks are in the way.".into());
        }
        let what = match reason {
            RemovalReason::Filler => "filler word",
            RemovalReason::Silence => "silence",
            RemovalReason::RoughCut => "passage",
            _ => "transcript range",
        };
        Ok(if count == 1 {
            format!("Remove {what}")
        } else {
            format!("Remove {count} {what}s")
        })
    }

    fn heal_cuts(&mut self, left_ids: &[ClipId]) -> CmdResult<String> {
        let ids = self.editable_clips(left_ids)?;
        let fps = self.fps();
        let mut cut_at: Option<TimelineTime> = None;
        let mut gap: Option<Ticks> = None;
        let mut pairs: Vec<(ClipId, ClipId)> = Vec::new();
        for id in &ids {
            let left = self.p.clips[id].clone();
            let asset = left.asset_id().map(str::to_string);
            let right = self
                .p
                .clips
                .values()
                .find(|c| c.track_id == left.track_id && c.start == left.end())
                .cloned()
                .ok_or_else(|| CommandError::conflict("This cut can no longer be restored automatically (the clips after it were moved). Use undo instead."))?;
            let compatible = left.content.is_timed_media()
                && std::mem::discriminant(&left.content) == std::mem::discriminant(&right.content)
                && right.asset_id().map(str::to_string) == asset
                && right.speed == left.speed
                && right.source_in > left.source_out();
            if !compatible {
                return Err(CommandError::conflict(
                    "There is no removed media between these clips to restore.",
                ));
            }
            let g = fps
                .snap(
                    left.speed
                        .source_to_output(right.source_in - left.source_out()),
                )
                .max(fps.frame_ticks());
            if gap.is_some_and(|x| x != g) || cut_at.is_some_and(|x| x != left.end()) {
                return Err(CommandError::conflict(
                    "The selected cuts do not line up; restore them one at a time.",
                ));
            }
            gap = Some(g);
            cut_at = Some(left.end());
            pairs.push((left.id.clone(), right.id.clone()));
        }
        let (gap, cut_at) = (gap.unwrap(), cut_at.unwrap());
        let none = BTreeSet::new();
        self.shift_from(cut_at, gap, &none);
        for (l, r) in &pairs {
            let right = self.p.clips.remove(r).unwrap();
            let left = self.p.clips.get_mut(l).unwrap();
            let healed = (left.source_out(), right.source_in);
            left.duration = right.end() - left.start;
            left.fade_out = right.fade_out;
            let asset = left.asset_id().map(str::to_string);
            for t in self.p.transitions.values_mut() {
                if &t.left == r {
                    t.left = l.clone();
                }
            }
            self.p.transitions.retain(|_, t| &t.right != r);
            // the audit entries for this gap are resolved
            let tol = fps.frame_ticks();
            self.p.transcript.removals.retain(|x| {
                !(Some(&x.asset_id) == asset.as_ref()
                    && x.source_start.0 >= healed.0 .0 - tol
                    && x.source_end.0 <= healed.1 .0 + tol)
            });
        }
        Ok("Restore removed media".into())
    }
}

/// Largest whole number of *even* frames not exceeding `d` (so half a transition is
/// frame aligned).
fn even_frames(fps: FrameRate, d: Ticks) -> Ticks {
    let frames = fps.ticks_to_frame_floor(d.clamp(0, MAX_TIMELINE_TICKS));
    fps.frame_to_ticks(frames - frames % 2)
}

fn trim_float(f: f64) -> String {
    let s = format!("{f:.3}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// Upper bound for any timeline position (24 h).
pub const MAX_TIMELINE_TICKS: Ticks = 24 * 3600 * crate::time::TICKS_PER_SECOND;

pub(crate) fn validate_transform(t: &Transform) -> CmdResult<()> {
    check_finite("x", t.x, -4.0, 4.0)?;
    check_finite("y", t.y, -4.0, 4.0)?;
    check_finite("scale", t.scale, 0.01, 20.0)?;
    check_finite("rotation", t.rotation, -3600.0, 3600.0)?;
    check_finite("opacity", t.opacity, 0.0, 1.0)?;
    for (n, v) in [
        ("crop_left", t.crop.left),
        ("crop_top", t.crop.top),
        ("crop_right", t.crop.right),
        ("crop_bottom", t.crop.bottom),
    ] {
        check_finite(n, v, 0.0, 0.95)?;
    }
    if t.crop.left + t.crop.right > 0.95 || t.crop.top + t.crop.bottom > 0.95 {
        return Err(CommandError::invalid(
            "crop",
            "The crop removes the whole picture",
        ));
    }
    Ok(())
}

pub(crate) fn validate_color(c: &ColorAdjust) -> CmdResult<()> {
    check_finite("brightness", c.brightness, 0.0, 2.0)?;
    check_finite("contrast", c.contrast, 0.0, 2.0)?;
    check_finite("saturation", c.saturation, 0.0, 2.0)?;
    check_finite("temperature", c.temperature, -1.0, 1.0)?;
    Ok(())
}

pub(crate) fn validate_text_style(s: &TextStyle) -> CmdResult<()> {
    check_finite("font_size", s.font_size, 0.01, 0.5)?;
    check_finite("outline_width", s.outline_width, 0.0, 0.3)?;
    if !is_color(&s.color, false) {
        return Err(CommandError::invalid(
            "text_color",
            "Text colour must be a hex colour like #rrggbb",
        ));
    }
    if !is_color(&s.outline_color, false) {
        return Err(CommandError::invalid(
            "outline_color",
            "Outline colour must be a hex colour like #rrggbb",
        ));
    }
    if let Some(b) = &s.background {
        if !is_color(b, true) {
            return Err(CommandError::invalid(
                "background",
                "Background must be a hex colour like #rrggbb or #rrggbbaa",
            ));
        }
    }
    Ok(())
}

impl From<ErrorCode> for &'static str {
    fn from(c: ErrorCode) -> &'static str {
        match c {
            ErrorCode::InvalidArgument => "invalid_argument",
            ErrorCode::NotFound => "not_found",
            ErrorCode::TrackLocked => "track_locked",
            ErrorCode::Conflict => "conflict",
            ErrorCode::InvariantViolation => "invariant_violation",
            ErrorCode::StaleRevision => "stale_revision",
            ErrorCode::NothingToDo => "nothing_to_do",
        }
    }
}
