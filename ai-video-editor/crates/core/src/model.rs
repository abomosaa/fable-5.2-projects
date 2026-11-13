//! The project document: the single deterministic representation of an edit.
//!
//! Everything the UI shows, the preview plays, the transcript maps against and the
//! exporter renders is derived from this document (plus immutable per-asset data such
//! as transcripts). There is no UI-only editing state.

use crate::time::{ClipTime, FrameRate, SourceTime, Speed, Ticks, TimelineTime, TICKS_PER_SECOND};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub type AssetId = String;
pub type ClipId = String;
pub type TrackId = String;
pub type TransitionId = String;
pub type MarkerId = String;

pub const SCHEMA_VERSION: u32 = 1;
pub const MAX_DIMENSION: u32 = 4096;
pub const MIN_DIMENSION: u32 = 16;
pub const MAX_FPS: f64 = 60.0;
pub const MAX_TRACKS: usize = 64;
pub const DEFAULT_STILL_DURATION: Ticks = 5 * TICKS_PER_SECOND;

// ---------------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetKind {
    Video,
    Audio,
    Image,
    Subtitle,
}

/// Immutable facts about an imported media file, captured by probing at import time.
/// Processing status (proxies, transcription …) is deliberately *not* part of the
/// project document; it lives in the server's asset store.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AssetInfo {
    pub id: AssetId,
    pub name: String,
    pub kind: AssetKind,
    /// Media duration in source time (0 for stills and subtitle files).
    pub duration: Ticks,
    pub has_video: bool,
    pub has_audio: bool,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    #[serde(default)]
    pub fps: Option<FrameRate>,
    #[serde(default)]
    pub sample_rate: Option<u32>,
    #[serde(default)]
    pub channels: Option<u32>,
}

// ---------------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrackKind {
    Video,
    Audio,
    Caption,
}

impl TrackKind {
    pub fn prefix(self) -> &'static str {
        match self {
            TrackKind::Video => "V",
            TrackKind::Audio => "A",
            TrackKind::Caption => "C",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Track {
    pub id: TrackId,
    pub kind: TrackKind,
    pub name: String,
    /// Audio tracks: silenced. Ignored for other kinds.
    #[serde(default)]
    pub muted: bool,
    /// Audio tracks: when any track is soloed only soloed tracks are audible.
    #[serde(default)]
    pub solo: bool,
    /// Locked tracks reject every mutation and are skipped by ripple operations.
    #[serde(default)]
    pub locked: bool,
    /// Video / caption tracks: not rendered.
    #[serde(default)]
    pub hidden: bool,
    /// Audio tracks: track gain in dB applied on top of clip gain.
    #[serde(default)]
    pub gain_db: f64,
}

// ---------------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TextAlign {
    Left,
    #[default]
    Center,
    Right,
}

/// Text appearance. Sizes are relative to the output frame so the look is identical
/// at every export resolution and in the preview.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TextStyle {
    /// Font size as a fraction of the output frame height.
    pub font_size: f64,
    /// `#rrggbb`
    pub color: String,
    pub bold: bool,
    pub align: TextAlign,
    /// Optional box behind the text, `#rrggbb` or `#rrggbbaa`.
    #[serde(default)]
    pub background: Option<String>,
    /// `#rrggbb`
    pub outline_color: String,
    /// Outline width as a fraction of the font size (0 disables).
    pub outline_width: f64,
    pub shadow: bool,
}

impl Default for TextStyle {
    fn default() -> Self {
        TextStyle {
            font_size: 0.09,
            color: "#ffffff".into(),
            bold: true,
            align: TextAlign::Center,
            background: None,
            outline_color: "#000000".into(),
            outline_width: 0.0,
            shadow: true,
        }
    }
}

/// Project-wide caption appearance (all captions share one look).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CaptionStyle {
    pub text: TextStyle,
    /// Vertical centre of the caption block, as an offset from the frame centre in
    /// fractions of the frame height (0.38 == lower third).
    pub y: f64,
}

impl Default for CaptionStyle {
    fn default() -> Self {
        CaptionStyle {
            text: TextStyle {
                font_size: 0.048,
                color: "#ffffff".into(),
                bold: true,
                align: TextAlign::Center,
                background: Some("#000000b3".into()),
                outline_color: "#000000".into(),
                outline_width: 0.0,
                shadow: false,
            },
            y: 0.38,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct Crop {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

/// Spatial placement of a visual clip.
///
/// * `x`, `y`: offset of the clip centre from the frame centre, in fractions of the
///   frame width / height (0,0 == centred; +x right, +y down).
/// * `scale`: 1.0 == the (cropped) source is fitted inside the frame ("contain").
/// * `rotation`: degrees, clockwise.
/// * `crop`: fraction of the source removed from each edge.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Transform {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub rotation: f64,
    pub opacity: f64,
    #[serde(default)]
    pub crop: Crop,
    #[serde(default)]
    pub flip_h: bool,
    #[serde(default)]
    pub flip_v: bool,
}

impl Default for Transform {
    fn default() -> Self {
        Transform {
            x: 0.0,
            y: 0.0,
            scale: 1.0,
            rotation: 0.0,
            opacity: 1.0,
            crop: Crop::default(),
            flip_h: false,
            flip_v: false,
        }
    }
}

impl Transform {
    pub fn is_identity(&self) -> bool {
        *self == Transform::default()
    }
}

/// Basic colour controls. All defaults are neutral.
///
/// * `brightness`: multiplier, 0..=2 (1 neutral)
/// * `contrast`:   multiplier around mid grey, 0..=2 (1 neutral)
/// * `saturation`: 0..=2 (1 neutral, 0 greyscale)
/// * `temperature`: -1..=1 (negative cooler/bluer, positive warmer)
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct ColorAdjust {
    pub brightness: f64,
    pub contrast: f64,
    pub saturation: f64,
    pub temperature: f64,
}

impl Default for ColorAdjust {
    fn default() -> Self {
        ColorAdjust {
            brightness: 1.0,
            contrast: 1.0,
            saturation: 1.0,
            temperature: 0.0,
        }
    }
}

impl ColorAdjust {
    pub fn is_neutral(&self) -> bool {
        *self == ColorAdjust::default()
    }
}

/// Provenance of an auto-generated caption: which source words it was built from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CaptionSource {
    pub asset_id: AssetId,
    pub word_start: u32,
    /// Exclusive.
    pub word_end: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClipContent {
    /// Picture of a video asset (audio lives in a separate, usually linked, audio clip).
    Video { asset_id: AssetId },
    /// Sound of an audio or video asset.
    Audio { asset_id: AssetId },
    /// Still image.
    Image { asset_id: AssetId },
    /// Text overlay / title.
    Text { text: String, style: TextStyle },
    /// Caption cue (styled by the project caption style).
    Caption {
        text: String,
        #[serde(default)]
        speaker: Option<String>,
        #[serde(default)]
        source: Option<CaptionSource>,
        /// True when produced by "Generate captions" (replaced on regeneration).
        #[serde(default)]
        generated: bool,
    },
}

impl ClipContent {
    pub fn asset_id(&self) -> Option<&str> {
        match self {
            ClipContent::Video { asset_id }
            | ClipContent::Audio { asset_id }
            | ClipContent::Image { asset_id } => Some(asset_id),
            _ => None,
        }
    }
    /// Which kind of track this content may live on.
    pub fn track_kind(&self) -> TrackKind {
        match self {
            ClipContent::Video { .. } | ClipContent::Image { .. } | ClipContent::Text { .. } => {
                TrackKind::Video
            }
            ClipContent::Audio { .. } => TrackKind::Audio,
            ClipContent::Caption { .. } => TrackKind::Caption,
        }
    }
    /// True when the clip plays time-based media (bounded by the asset duration).
    pub fn is_timed_media(&self) -> bool {
        matches!(self, ClipContent::Video { .. } | ClipContent::Audio { .. })
    }
    pub fn is_visual(&self) -> bool {
        !matches!(self, ClipContent::Audio { .. })
    }
    pub fn kind_name(&self) -> &'static str {
        match self {
            ClipContent::Video { .. } => "video",
            ClipContent::Audio { .. } => "audio",
            ClipContent::Image { .. } => "image",
            ClipContent::Text { .. } => "text",
            ClipContent::Caption { .. } => "caption",
        }
    }
}

/// A clip: a span of output time on one track showing a span of some source.
///
/// Time domains:
/// * `start`, `duration`      – output **timeline** time (always frame aligned)
/// * `source_in`              – **source** time of the first shown instant
/// * `speed`                  – source ticks consumed per output tick
/// * clip-local time          – `timeline - start` (see [`Clip::clip_time`])
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Clip {
    pub id: ClipId,
    pub track_id: TrackId,
    pub start: TimelineTime,
    pub duration: Ticks,
    pub source_in: SourceTime,
    #[serde(default)]
    pub speed: Speed,
    pub content: ClipContent,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Clips sharing a `link_id` are A/V-linked (DaVinci Resolve style): with linked
    /// selection on they select, move, trim and split together, and the UI flags
    /// them when they drift out of sync.
    #[serde(default)]
    pub link_id: Option<String>,
    /// Clips sharing a `group_id` always behave as one unit.
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub transform: Transform,
    #[serde(default)]
    pub color: ColorAdjust,
    /// Clip gain in dB (audio clips).
    #[serde(default)]
    pub gain_db: f64,
    /// Fade-in length in output time (opacity for visual clips, gain for audio).
    #[serde(default)]
    pub fade_in: Ticks,
    #[serde(default)]
    pub fade_out: Ticks,
}

fn default_true() -> bool {
    true
}

impl Clip {
    #[inline]
    pub fn end(&self) -> TimelineTime {
        self.start + self.duration
    }
    /// Source duration consumed by this clip.
    #[inline]
    pub fn source_duration(&self) -> Ticks {
        self.speed.output_to_source(self.duration)
    }
    #[inline]
    pub fn source_out(&self) -> SourceTime {
        self.source_in + self.source_duration()
    }
    #[inline]
    pub fn contains(&self, t: TimelineTime) -> bool {
        t >= self.start && t < self.end()
    }
    #[inline]
    pub fn overlaps(&self, start: TimelineTime, end: TimelineTime) -> bool {
        self.start < end && self.end() > start
    }
    /// Timeline → clip-local time (not clamped).
    #[inline]
    pub fn clip_time(&self, t: TimelineTime) -> ClipTime {
        ClipTime(t - self.start)
    }
    /// Clip-local → source time (not clamped; extrapolates linearly outside the clip).
    #[inline]
    pub fn clip_to_source(&self, c: ClipTime) -> SourceTime {
        self.source_in + self.speed.output_to_source(c.0)
    }
    /// Timeline → source time (not clamped).
    #[inline]
    pub fn source_time_at(&self, t: TimelineTime) -> SourceTime {
        self.clip_to_source(self.clip_time(t))
    }
    /// Source → timeline time (not clamped).
    #[inline]
    pub fn timeline_time_of(&self, s: SourceTime) -> TimelineTime {
        self.start + self.speed.source_to_output(s - self.source_in)
    }
    #[inline]
    pub fn asset_id(&self) -> Option<&str> {
        self.content.asset_id()
    }
    /// The constant offset `start - source_in/speed` that two linked clips of the same
    /// asset share while they are in sync.
    #[inline]
    pub fn sync_anchor(&self) -> Ticks {
        self.start.0 - self.speed.source_to_output(self.source_in.0)
    }
}

// ---------------------------------------------------------------------------------
// Transitions, markers
// ---------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransitionKind {
    /// Outgoing clip dissolves into the incoming clip (audio: crossfade).
    CrossDissolve,
    /// Outgoing fades to black, incoming fades up from black.
    DipToBlack,
    /// Incoming clip slides in from the right over the outgoing clip.
    Slide,
    /// Incoming clip pushes the outgoing clip out to the left.
    Push,
}

/// A transition centred on the cut between two adjacent clips of one track.
/// It occupies `[cut - duration/2, cut + duration/2)`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Transition {
    pub id: TransitionId,
    pub kind: TransitionKind,
    pub left: ClipId,
    pub right: ClipId,
    pub duration: Ticks,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Marker {
    pub id: MarkerId,
    pub time: TimelineTime,
    pub label: String,
    pub color: String,
}

// ---------------------------------------------------------------------------------
// Transcript editing state (project-level, undoable)
// ---------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemovalReason {
    Manual,
    Filler,
    Silence,
    RoughCut,
    Assistant,
}

/// Audit record for a transcript-driven ripple edit: which *source* range of which
/// asset was removed, where it sat on the timeline at that moment and why.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RemovalTrace {
    pub id: String,
    pub asset_id: AssetId,
    /// The clip the range was cut out of (it may since have been split/renamed).
    pub clip_id: ClipId,
    pub source_start: SourceTime,
    pub source_end: SourceTime,
    pub timeline_start: TimelineTime,
    pub timeline_end: TimelineTime,
    pub reason: RemovalReason,
    /// The spoken text that was removed (for display).
    #[serde(default)]
    pub text: String,
    /// Project revision that performed the removal.
    pub revision: u64,
}

/// Non-destructive transcript edits. The original provider tokens and source
/// timestamps are never modified; corrections are an overlay keyed by word index.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TranscriptState {
    /// Transcript-based editing has been switched on for this project.
    #[serde(default)]
    pub enabled: bool,
    /// asset → word index → corrected display text.
    #[serde(default)]
    pub corrections: BTreeMap<AssetId, BTreeMap<u32, String>>,
    /// asset → provider speaker id → display name.
    #[serde(default)]
    pub speaker_names: BTreeMap<AssetId, BTreeMap<String, String>>,
    #[serde(default)]
    pub removals: Vec<RemovalTrace>,
}

// ---------------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProjectSettings {
    pub width: u32,
    pub height: u32,
    pub fps: FrameRate,
    pub sample_rate: u32,
    /// `#rrggbb` canvas background.
    pub background: String,
    #[serde(default)]
    pub caption_style: CaptionStyle,
}

impl Default for ProjectSettings {
    fn default() -> Self {
        ProjectSettings {
            width: 1920,
            height: 1080,
            fps: FrameRate::FPS_30,
            sample_rate: 48_000,
            background: "#000000".into(),
            caption_style: CaptionStyle::default(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Project {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    /// Monotonic revision; bumped by every committed command, undo and redo.
    pub revision: u64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub settings: ProjectSettings,
    pub assets: BTreeMap<AssetId, AssetInfo>,
    /// Display order, top to bottom. Visual stacking is the reverse: the first
    /// video/caption track is drawn on top.
    pub tracks: Vec<Track>,
    pub clips: BTreeMap<ClipId, Clip>,
    #[serde(default)]
    pub transitions: BTreeMap<TransitionId, Transition>,
    #[serde(default)]
    pub markers: Vec<Marker>,
    #[serde(default)]
    pub transcript: TranscriptState,
    /// Monotonic id counter (never rewound, not even by undo).
    pub next_id: u64,
}

impl Project {
    pub fn new(id: impl Into<String>, name: impl Into<String>, now_ms: i64) -> Project {
        let mut p = Project {
            schema_version: SCHEMA_VERSION,
            id: id.into(),
            name: name.into(),
            revision: 0,
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
            settings: ProjectSettings::default(),
            assets: BTreeMap::new(),
            tracks: Vec::new(),
            clips: BTreeMap::new(),
            transitions: BTreeMap::new(),
            markers: Vec::new(),
            transcript: TranscriptState::default(),
            next_id: 0,
        };
        for (kind, name) in [
            (TrackKind::Video, "V2"),
            (TrackKind::Video, "V1"),
            (TrackKind::Audio, "A1"),
            (TrackKind::Audio, "A2"),
        ] {
            let id = p.gen_id("t");
            p.tracks.push(Track {
                id,
                kind,
                name: name.into(),
                muted: false,
                solo: false,
                locked: false,
                hidden: false,
                gain_db: 0.0,
            });
        }
        p
    }

    /// Allocate a fresh deterministic id such as `c42`.
    pub fn gen_id(&mut self, prefix: &str) -> String {
        self.next_id += 1;
        format!("{prefix}{}", self.next_id)
    }

    #[inline]
    pub fn fps(&self) -> FrameRate {
        self.settings.fps
    }

    pub fn track(&self, id: &str) -> Option<&Track> {
        self.tracks.iter().find(|t| t.id == id)
    }

    pub fn track_index(&self, id: &str) -> Option<usize> {
        self.tracks.iter().position(|t| t.id == id)
    }

    /// Clips of one track sorted by start time.
    pub fn track_clips(&self, track_id: &str) -> Vec<&Clip> {
        let mut v: Vec<&Clip> = self
            .clips
            .values()
            .filter(|c| c.track_id == track_id)
            .collect();
        v.sort_by_key(|c| (c.start, c.id.clone()));
        v
    }

    /// End of the last clip (the output duration).
    pub fn duration(&self) -> Ticks {
        self.clips.values().map(|c| c.end().0).max().unwrap_or(0)
    }

    /// Tracks of `kind` ordered from the one nearest the V/A divider outwards
    /// (V1, V2, … / A1, A2, … / C1, …).
    pub fn tracks_of_kind(&self, kind: TrackKind) -> Vec<&Track> {
        let mut v: Vec<&Track> = self.tracks.iter().filter(|t| t.kind == kind).collect();
        if kind != TrackKind::Audio {
            v.reverse();
        }
        v
    }

    /// 0-based ordinal of a track within its kind (V1 == 0, counted from the divider).
    pub fn track_ordinal(&self, track_id: &str) -> Option<usize> {
        let t = self.track(track_id)?;
        self.tracks_of_kind(t.kind)
            .iter()
            .position(|x| x.id == track_id)
    }

    /// True when at least one audio track is soloed.
    pub fn any_solo(&self) -> bool {
        self.tracks
            .iter()
            .any(|t| t.kind == TrackKind::Audio && t.solo)
    }

    /// Is this track's content part of the output?
    pub fn track_active(&self, t: &Track) -> bool {
        match t.kind {
            TrackKind::Audio => !t.muted && (!self.any_solo() || t.solo),
            _ => !t.hidden,
        }
    }

    pub fn transition_into(&self, clip_id: &str) -> Option<&Transition> {
        self.transitions.values().find(|t| t.right == clip_id)
    }

    pub fn transition_out_of(&self, clip_id: &str) -> Option<&Transition> {
        self.transitions.values().find(|t| t.left == clip_id)
    }
}
