//! FFmpeg render-plan generation (pure: builds argument lists and filter graphs, no I/O).
//!
//! The export consumes exactly the same inputs as the browser preview: the project
//! document and its resolved [`Layer`]s. Fades, transitions and handles are *never*
//! re-derived here — they come from `resolve::resolve_layers`.
//!
//! ## Pipeline
//!
//! The output range is cut into frame-aligned **chunks** (≤ ~20 s and ≤ ~24 layer
//! portions each). Every chunk is rendered by its own FFmpeg process into a NUT
//! intermediate (final video codec, 24-bit PCM audio) with an exact frame and sample
//! count. The chunks are then joined with the concat demuxer: video is stream-copied,
//! audio is encoded once. This keeps filter graphs small, bounds the number of open
//! decoders, and gives real progress, parallelism and cancellation.
//!
//! NUT (not Matroska) is used for the intermediates because it stores exact rational
//! timestamps; Matroska's millisecond timebase would turn 60 fps into jittery VFR.
//!
//! ## File name convention
//!
//! Every relative file name in a plan (`chunk_0000.nut`, `text_c12.txt`,
//! `font-bold.ttf`, `chunks.ffconcat`, `output.mp4`) is relative to the **job
//! directory**; the runner writes [`RenderPlan::text_files`], copies
//! [`RenderPlan::font_files`] there and runs FFmpeg with that directory as its
//! working directory. Media inputs are absolute paths passed as plain `-i` arguments,
//! so no user-controlled string ever needs filter-graph escaping.
//!
//! ## Layout, text and colour conventions (mirrored by the preview)
//!
//! See the item docs on [`layout_rect`], [`text_metrics`] and [`color_matrix`].

use crate::model::*;
use crate::resolve::{Layer, Ramp, Slide};
use crate::time::{
    ticks_to_samples, ticks_to_seconds_string, FrameRate, Ticks, TimelineTime, TICKS_PER_SECOND,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt::Write as _;

/// Longest chunk, in seconds.
pub const CHUNK_MAX_SECONDS: i64 = 20;
/// Shortest chunk a busy stretch is split down to, in seconds.
pub const CHUNK_MIN_SECONDS: i64 = 1;
/// Maximum number of layer portions (video, image, text, caption, audio) per chunk.
pub const CHUNK_MAX_PORTIONS: usize = 24;

/// Line height of the bundled Inter font as a multiple of the font size
/// (ascender 0.96875 − descender −0.2412 = 1.21).
pub const TEXT_LINE_HEIGHT: f64 = 1.21;
/// Padding of the text background box as a multiple of the font size.
pub const TEXT_BOX_PADDING: f64 = 0.3;
/// Shadow offset (x and y) as a multiple of the font size.
pub const TEXT_SHADOW_OFFSET: f64 = 0.06;
/// Shadow colour alpha.
pub const TEXT_SHADOW_ALPHA: f64 = 0.6;

pub const FONT_REGULAR_NAME: &str = "font-regular.ttf";
pub const FONT_BOLD_NAME: &str = "font-bold.ttf";
pub const CONCAT_LIST_NAME: &str = "chunks.ffconcat";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum VideoCodec {
    #[default]
    H264,
    Hevc,
    Vp9,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Quality {
    Draft,
    #[default]
    Standard,
    High,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ExportSettings {
    pub width: u32,
    pub height: u32,
    pub fps: FrameRate,
    #[serde(default)]
    pub video_codec: VideoCodec,
    #[serde(default)]
    pub quality: Quality,
    #[serde(default = "default_audio_bitrate")]
    pub audio_bitrate_kbps: u32,
    #[serde(default = "default_true")]
    pub burn_captions: bool,
    /// Optional `[start, end)` timeline range; `None` exports the whole timeline.
    #[serde(default)]
    pub range: Option<(TimelineTime, TimelineTime)>,
}

fn default_audio_bitrate() -> u32 {
    192
}
fn default_true() -> bool {
    true
}

impl ExportSettings {
    pub fn from_project(p: &Project) -> Self {
        ExportSettings {
            width: p.settings.width,
            height: p.settings.height,
            fps: p.settings.fps,
            video_codec: VideoCodec::H264,
            quality: Quality::Standard,
            audio_bitrate_kbps: 192,
            burn_captions: true,
            range: None,
        }
    }

    pub fn validate(&self) -> Result<(), RenderError> {
        let bad = |field: &str, message: String| {
            Err(RenderError::InvalidSettings {
                field: field.to_string(),
                message,
            })
        };
        for (field, v) in [("width", self.width), ("height", self.height)] {
            if !(MIN_DIMENSION..=MAX_DIMENSION).contains(&v) {
                return bad(field, format!("Export {field} must be between {MIN_DIMENSION} and {MAX_DIMENSION} pixels (up to 4K)."));
            }
            if v % 2 != 0 {
                return bad(
                    field,
                    format!("Export {field} must be an even number of pixels."),
                );
            }
        }
        if FrameRate::new(self.fps.num, self.fps.den).is_none() {
            return bad("fps", "The export frame rate is not valid.".into());
        }
        if self.fps.as_f64() > MAX_FPS + 1e-6 {
            return bad(
                "fps",
                format!("The export frame rate must not exceed {MAX_FPS} fps."),
            );
        }
        if !(32..=512).contains(&self.audio_bitrate_kbps) {
            return bad(
                "audio_bitrate_kbps",
                "Audio bitrate must be between 32 and 512 kbps.".into(),
            );
        }
        if let Some((s, e)) = self.range {
            if s.0 < 0 || e <= s {
                return bad(
                    "range",
                    "The export range must start at or after 0 and end after it starts.".into(),
                );
            }
        }
        Ok(())
    }

    /// Container extension of the final file.
    pub fn extension(&self) -> &'static str {
        match self.video_codec {
            VideoCodec::H264 | VideoCodec::Hevc => "mp4",
            VideoCodec::Vp9 => "webm",
        }
    }

    pub fn mime_type(&self) -> &'static str {
        match self.video_codec {
            VideoCodec::H264 | VideoCodec::Hevc => "video/mp4",
            VideoCodec::Vp9 => "video/webm",
        }
    }
}

/// Where an asset's original media lives and what it contains.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MediaSource {
    /// Absolute path of the original file.
    pub path: String,
    pub kind: AssetKind,
    pub has_video: bool,
    pub has_audio: bool,
    /// Display size (rotation already applied).
    pub width: u32,
    pub height: u32,
    pub duration: Ticks,
    /// Source frame rate when known; used to seek to the frame that *contains* a
    /// source instant, exactly like the preview does.
    #[serde(default)]
    pub fps: Option<FrameRate>,
    /// Audio channel count when known (mono is spread to both speakers at unity).
    #[serde(default)]
    pub channels: Option<u32>,
}

/// Paths of the fonts used for text and captions.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RenderEnv {
    pub font_regular: String,
    pub font_bold: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TextFile {
    pub name: String,
    pub content: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FontFile {
    /// File name inside the job directory.
    pub name: String,
    /// Absolute path to copy from.
    pub source: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputRole {
    Video,
    Image,
    Audio,
}

/// One FFmpeg input of a chunk (kept structured for inspection and tests).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanInput {
    pub index: usize,
    pub clip_id: ClipId,
    pub asset_id: AssetId,
    pub role: InputRole,
    pub path: String,
    /// Source time of the input seek (`-ss`), if any.
    pub seek: Option<Ticks>,
    /// Source duration limit (`-t`), if any.
    pub limit: Option<Ticks>,
    /// The input's arguments, ending with `-i <path>`.
    pub args: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChunkPlan {
    pub index: usize,
    pub start: TimelineTime,
    pub end: TimelineTime,
    /// First output frame (relative to the export start) and frame count.
    pub first_frame: i64,
    pub frames: i64,
    /// Exact number of audio samples in the chunk.
    pub samples: i64,
    pub inputs: Vec<PlanInput>,
    pub filter_complex: String,
    /// Complete FFmpeg arguments (after the binary). Relative names refer to the job dir.
    pub args: Vec<String>,
    pub output_name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RenderPlan {
    /// Timeline range being exported.
    pub start: TimelineTime,
    pub end: TimelineTime,
    /// Exact output duration (`total_frames` frames).
    pub duration: Ticks,
    pub total_frames: i64,
    pub chunks: Vec<ChunkPlan>,
    pub text_files: Vec<TextFile>,
    pub font_files: Vec<FontFile>,
    pub concat_list_name: String,
    /// Body of the ffconcat list joining the chunks.
    pub concat_list: String,
    /// Arguments of the final concat + audio-encode + mux step.
    pub final_args: Vec<String>,
    pub output_name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, thiserror::Error)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum RenderError {
    #[error("There is nothing to export yet. Add at least one clip to the timeline.")]
    EmptyTimeline,
    #[error("{message}")]
    InvalidSettings { field: String, message: String },
    #[error("The media file for “{name}” is not available. Re-import it or remove its clips, then export again.")]
    MissingSource { asset_id: AssetId, name: String },
    #[error("“{name}” cannot be used here: {message}")]
    UnusableSource {
        asset_id: AssetId,
        name: String,
        message: String,
    },
}

impl RenderError {
    pub fn code(&self) -> &'static str {
        match self {
            RenderError::EmptyTimeline => "empty_timeline",
            RenderError::InvalidSettings { .. } => "invalid_settings",
            RenderError::MissingSource { .. } => "missing_source",
            RenderError::UnusableSource { .. } => "unusable_source",
        }
    }
}

// ---------------------------------------------------------------------------------
// Shared layout / text / colour math
// ---------------------------------------------------------------------------------

/// Placement of a picture on the canvas.
///
/// With canvas `W×H`, source display size `sw×sh` and crop fractions `l,t,r,b`:
/// `cw = sw·(1−l−r)`, `ch = sh·(1−t−b)`, fit factor `f = min(W/cw, H/ch)`,
/// displayed size `dw = cw·f·scale`, `dh = ch·f·scale` (rounded to whole pixels, at
/// least 1), centre `cx = W/2 + x·W`, `cy = H/2 + y·H`. Flips mirror the picture in
/// place, then it is rotated clockwise by `rotation` degrees about its centre.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LayoutRect {
    pub dw: i64,
    pub dh: i64,
    pub cx: f64,
    pub cy: f64,
}

pub fn layout_rect(
    canvas_w: u32,
    canvas_h: u32,
    src_w: u32,
    src_h: u32,
    t: &Transform,
) -> LayoutRect {
    let (w, h) = (canvas_w as f64, canvas_h as f64);
    let (sw, sh) = if src_w == 0 || src_h == 0 {
        (w, h)
    } else {
        (src_w as f64, src_h as f64)
    };
    let cw = (sw * (1.0 - t.crop.left - t.crop.right)).max(1.0);
    let ch = (sh * (1.0 - t.crop.top - t.crop.bottom)).max(1.0);
    let f = (w / cw).min(h / ch);
    LayoutRect {
        dw: ((cw * f * t.scale).round() as i64).max(1),
        dh: ((ch * f * t.scale).round() as i64).max(1),
        cx: w / 2.0 + t.x * w,
        cy: h / 2.0 + t.y * h,
    }
}

/// Text geometry.
///
/// Font size in pixels is `round(font_size · H · scale)` (min 1). Lines are split on
/// `\n` only (no automatic wrapping). Each line is `TEXT_LINE_HEIGHT · px` tall with
/// the baseline `0.96875 · px` below the line top; the block of `n` lines is centred
/// on `(cx, cy)`: its top is `round(cy − n·1.21·px/2)` and it is as wide as its widest
/// line, centred on `cx`; `align` positions the lines inside the block. The optional
/// background box extends `round(0.3·px)` beyond the block on every side. The outline
/// is an outer border `round(outline_width·px)` wide; the shadow is the text offset by
/// `max(1, round(0.06·px))` in x and y, black at 60 % opacity, no blur.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TextMetrics {
    pub font_px: i64,
    pub lines: usize,
    pub block_top: i64,
    pub box_padding: i64,
    pub outline_px: i64,
    pub shadow_px: i64,
}

pub fn text_metrics(
    canvas_h: u32,
    style: &TextStyle,
    scale: f64,
    text: &str,
    cy: f64,
) -> TextMetrics {
    let px = (style.font_size * canvas_h as f64 * scale).round().max(1.0);
    let lines = text.split('\n').count().max(1);
    TextMetrics {
        font_px: px as i64,
        lines,
        block_top: (cy - lines as f64 * TEXT_LINE_HEIGHT * px / 2.0).round() as i64,
        box_padding: (TEXT_BOX_PADDING * px).round() as i64,
        outline_px: (style.outline_width * px).round() as i64,
        shadow_px: ((TEXT_SHADOW_OFFSET * px).round() as i64).max(1),
    }
}

/// Colour adjustment, applied in gamma-encoded RGB with clamping to 0..1 after each
/// step: 1) temperature `T`: `r·(1+0.25T)`, `b·(1−0.25T)`; 2) brightness `B`: `c·B`;
/// 3) contrast `C`: `(c−0.5)·C+0.5`; 4) saturation `S`: `luma + (c−luma)·S` with
/// `luma = 0.2126r + 0.7152g + 0.0722b`. Returns the 3×3 saturation matrix (rows are
/// output r, g, b).
pub fn color_matrix(saturation: f64) -> [[f64; 3]; 3] {
    const L: [f64; 3] = [0.2126, 0.7152, 0.0722];
    let mut m = [[0.0; 3]; 3];
    for (row, out) in m.iter_mut().enumerate() {
        for (col, v) in out.iter_mut().enumerate() {
            *v = L[col] * (1.0 - saturation) + if row == col { saturation } else { 0.0 };
        }
    }
    m
}

// ---------------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------------

/// Compact, deterministic float formatting (≤ 6 decimals, no exponent, no `-0`).
fn num(v: f64) -> String {
    let mut s = format!("{v:.6}");
    if s.contains('.') {
        while s.ends_with('0') {
            s.pop();
        }
        if s.ends_with('.') {
            s.pop();
        }
    }
    if s == "-0" {
        s = "0".into();
    }
    s
}

fn secs(t: Ticks) -> String {
    ticks_to_seconds_string(t)
}

/// Seconds rounded *down* to the microsecond, so an accurate seek never skips the
/// frame that starts exactly at the requested instant.
fn secs_floor(t: Ticks) -> String {
    let micros = (t.max(0) as i128 * 1_000_000 / TICKS_PER_SECOND as i128) as i64;
    format!("{}.{:06}", micros / 1_000_000, micros % 1_000_000)
}

/// `#rrggbb[aa]` → FFmpeg colour (`0xRRGGBB` or `0xRRGGBB@a`).
fn ff_color(hex: &str) -> String {
    let h = hex.trim_start_matches('#');
    let valid = (h.len() == 6 || h.len() == 8) && h.bytes().all(|c| c.is_ascii_hexdigit());
    if !valid {
        return "0x000000".into();
    }
    if h.len() == 8 {
        let a = u8::from_str_radix(&h[6..8], 16).unwrap_or(255) as f64 / 255.0;
        format!(
            "0x{}@{}",
            &h[0..6].to_ascii_lowercase(),
            num((a * 1000.0).round() / 1000.0)
        )
    } else {
        format!("0x{}", h.to_ascii_lowercase())
    }
}

fn fps_str(f: FrameRate) -> String {
    if f.den == 1 {
        f.num.to_string()
    } else {
        format!("{}/{}", f.num, f.den)
    }
}

fn safe_name(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 {
        a
    } else {
        gcd(b, a % b)
    }
}

/// Chunk boundaries are multiples of this many frames so every chunk duration is a
/// whole number of microseconds (the concat list's resolution) and offsets never drift.
fn chunk_alignment(fps: FrameRate) -> i64 {
    let num = fps.num as u64;
    (num / gcd(num, fps.den as u64 * 1_000_000)).max(1) as i64
}

// ---------------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum ItemKind {
    Video,
    Image,
    Text,
    Caption,
    Audio,
}

struct Item<'a> {
    kind: ItemKind,
    layer: &'a Layer,
    clip: &'a Clip,
    source: Option<&'a MediaSource>,
    /// Layer extent in export frames (absolute timeline frames).
    fa: i64,
    fb: i64,
}

struct Ctx<'a> {
    project: &'a Project,
    settings: &'a ExportSettings,
    fps: FrameRate,
    sample_rate: u32,
}

/// Build the complete, deterministic render plan for a project.
pub fn build_plan(
    project: &Project,
    layers: &[Layer],
    sources: &BTreeMap<AssetId, MediaSource>,
    settings: &ExportSettings,
    env: &RenderEnv,
) -> Result<RenderPlan, RenderError> {
    settings.validate()?;
    let fps = FrameRate::new(settings.fps.num, settings.fps.den).unwrap();
    let timeline_end = project.duration();
    if project.clips.is_empty() || timeline_end <= 0 {
        return Err(RenderError::EmptyTimeline);
    }
    let (r0, r1) = match settings.range {
        Some((s, e)) => (s.0.max(0), e.0.min(timeline_end)),
        None => (0, timeline_end),
    };
    let f0 = fps.ticks_to_frame_round(r0);
    let f1 = fps
        .ticks_to_frame_round(r1)
        .max(if settings.range.is_none() { 1 } else { 0 });
    if f1 <= f0 {
        return Err(RenderError::InvalidSettings {
            field: "range".into(),
            message: "The export range does not contain any frames of the timeline.".into(),
        });
    }
    let ctx = Ctx {
        project,
        settings,
        fps,
        sample_rate: project.settings.sample_rate.clamp(8_000, 192_000),
    };

    // Collect everything that contributes to the output, in paint order.
    let mut ordered: Vec<&Layer> = layers.iter().filter(|l| l.active).collect();
    ordered.sort_by(|a, b| crate::resolve::paint_order(a, b));
    let mut items: Vec<Item> = Vec::new();
    for layer in ordered {
        let Some(clip) = project.clips.get(&layer.clip_id) else {
            continue;
        };
        let fa = fps.ticks_to_frame_round(layer.start.0).max(f0);
        let fb = fps.ticks_to_frame_round(layer.end.0).min(f1);
        if fb <= fa {
            continue;
        }
        let (kind, source) = match &clip.content {
            ClipContent::Text { .. } => (ItemKind::Text, None),
            ClipContent::Caption { .. } => {
                if !settings.burn_captions {
                    continue;
                }
                (ItemKind::Caption, None)
            }
            ClipContent::Video { asset_id }
            | ClipContent::Image { asset_id }
            | ClipContent::Audio { asset_id } => {
                let name = project
                    .assets
                    .get(asset_id)
                    .map(|a| a.name.clone())
                    .unwrap_or_else(|| asset_id.clone());
                let src = sources
                    .get(asset_id)
                    .ok_or_else(|| RenderError::MissingSource {
                        asset_id: asset_id.clone(),
                        name: name.clone(),
                    })?;
                let kind = match &clip.content {
                    ClipContent::Video { .. } => ItemKind::Video,
                    ClipContent::Image { .. } => ItemKind::Image,
                    _ => ItemKind::Audio,
                };
                let problem = match kind {
                    ItemKind::Video if !src.has_video || src.kind != AssetKind::Video => {
                        Some("it has no video stream")
                    }
                    ItemKind::Image if src.kind != AssetKind::Image => {
                        Some("it is not a still image")
                    }
                    ItemKind::Audio if !src.has_audio => Some("it has no audio stream"),
                    _ => None,
                };
                if let Some(p) = problem {
                    return Err(RenderError::UnusableSource {
                        asset_id: asset_id.clone(),
                        name,
                        message: p.to_string(),
                    });
                }
                (kind, Some(src))
            }
        };
        if kind == ItemKind::Audio && layer.gain <= 0.0 {
            continue;
        }
        if kind != ItemKind::Audio && clip.transform.opacity <= 0.0 && kind != ItemKind::Caption {
            continue;
        }
        items.push(Item {
            kind,
            layer,
            clip,
            source,
            fa,
            fb,
        });
    }

    // Chunk boundaries.
    let align = chunk_alignment(fps);
    let fps_f = fps.as_f64();
    let align_up = |n: i64| ((n + align - 1) / align) * align;
    let max_len = align_up(((CHUNK_MAX_SECONDS as f64 * fps_f).floor() as i64).max(1));
    let min_len = align_up(((CHUNK_MIN_SECONDS as f64 * fps_f).ceil() as i64).max(1));
    let count = |a: i64, b: i64| items.iter().filter(|it| it.fa < b && it.fb > a).count();
    let mut bounds: Vec<(i64, i64)> = Vec::new();
    let mut cursor = f0;
    while cursor < f1 {
        let mut len = max_len.min(f1 - cursor);
        while len > min_len && count(cursor, cursor + len) > CHUNK_MAX_PORTIONS {
            len = align_up((len / 2).max(min_len));
        }
        let mut end = cursor + len;
        // avoid a sliver at the very end
        if f1 - end < min_len / 2
            && count(cursor, f1) <= CHUNK_MAX_PORTIONS
            && f1 - cursor <= max_len + min_len
        {
            end = f1;
        }
        bounds.push((cursor, end.min(f1)));
        cursor = end.min(f1);
    }

    let sample_at = |f: i64| ticks_to_samples(fps.frame_to_ticks(f), ctx.sample_rate);
    let mut text_files: BTreeMap<String, String> = BTreeMap::new();
    let mut chunks = Vec::with_capacity(bounds.len());
    let mut concat_list = String::from("ffconcat version 1.0\n");
    for (index, (ca, cb)) in bounds.iter().copied().enumerate() {
        let output_name = format!("chunk_{index:04}.nut");
        let samples = sample_at(cb) - sample_at(ca);
        let chunk = build_chunk(
            &ctx,
            &items,
            index,
            ca,
            cb,
            f0,
            samples,
            &output_name,
            &mut text_files,
        );
        let _ = writeln!(concat_list, "file '{output_name}'");
        let _ = writeln!(
            concat_list,
            "duration {}",
            secs(fps.frame_to_ticks(cb) - fps.frame_to_ticks(ca))
        );
        chunks.push(chunk);
    }

    let output_name = format!("output.{}", settings.extension());
    let mut final_args: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-loglevel",
        "error",
        "-nostats",
        "-progress",
        "pipe:1",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        CONCAT_LIST_NAME,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-c:v",
        "copy",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let abr = format!("{}k", settings.audio_bitrate_kbps);
    match settings.video_codec {
        VideoCodec::H264 => final_args.extend(
            ["-c:a", "aac", "-b:a", &abr, "-movflags", "+faststart"]
                .iter()
                .map(|s| s.to_string()),
        ),
        VideoCodec::Hevc => final_args.extend(
            [
                "-tag:v",
                "hvc1",
                "-c:a",
                "aac",
                "-b:a",
                &abr,
                "-movflags",
                "+faststart",
            ]
            .iter()
            .map(|s| s.to_string()),
        ),
        VideoCodec::Vp9 => final_args.extend(
            ["-c:a", "libopus", "-b:a", &abr]
                .iter()
                .map(|s| s.to_string()),
        ),
    }
    final_args.push(output_name.clone());

    let font_files = if text_files.is_empty() {
        Vec::new()
    } else {
        vec![
            FontFile {
                name: FONT_REGULAR_NAME.into(),
                source: env.font_regular.clone(),
            },
            FontFile {
                name: FONT_BOLD_NAME.into(),
                source: env.font_bold.clone(),
            },
        ]
    };
    Ok(RenderPlan {
        start: TimelineTime(fps.frame_to_ticks(f0)),
        end: TimelineTime(fps.frame_to_ticks(f1)),
        duration: fps.frame_to_ticks(f1) - fps.frame_to_ticks(f0),
        total_frames: f1 - f0,
        chunks,
        text_files: text_files
            .into_iter()
            .map(|(name, content)| TextFile { name, content })
            .collect(),
        font_files,
        concat_list_name: CONCAT_LIST_NAME.into(),
        concat_list,
        final_args,
        output_name,
    })
}

fn video_encoder_args(settings: &ExportSettings, fps: FrameRate) -> Vec<String> {
    let gop = ((fps.as_f64() * 2.0).round() as i64).max(1).to_string();
    let mut v: Vec<String> = Vec::new();
    let mut push = |xs: &[&str]| v.extend(xs.iter().map(|s| s.to_string()));
    match settings.video_codec {
        VideoCodec::H264 => {
            let (preset, crf) = match settings.quality {
                Quality::Draft => ("veryfast", "27"),
                Quality::Standard => ("fast", "20"),
                Quality::High => ("slow", "16"),
            };
            push(&[
                "-c:v", "libx264", "-preset", preset, "-crf", crf, "-pix_fmt", "yuv420p", "-g",
                &gop,
            ]);
        }
        VideoCodec::Hevc => {
            let (preset, crf) = match settings.quality {
                Quality::Draft => ("veryfast", "30"),
                Quality::Standard => ("fast", "24"),
                Quality::High => ("slow", "20"),
            };
            push(&[
                "-c:v",
                "libx265",
                "-preset",
                preset,
                "-crf",
                crf,
                "-pix_fmt",
                "yuv420p",
                "-g",
                &gop,
                "-x265-params",
                "log-level=error:open-gop=0",
            ]);
        }
        VideoCodec::Vp9 => {
            let (cpu, crf) = match settings.quality {
                Quality::Draft => ("6", "38"),
                Quality::Standard => ("4", "32"),
                Quality::High => ("2", "24"),
            };
            push(&[
                "-c:v",
                "libvpx-vp9",
                "-deadline",
                "good",
                "-cpu-used",
                cpu,
                "-crf",
                crf,
                "-b:v",
                "0",
                "-row-mt",
                "1",
                "-tile-columns",
                "2",
                "-pix_fmt",
                "yuv420p",
                "-g",
                &gop,
            ]);
        }
    }
    push(&[
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-color_range",
        "tv",
    ]);
    v
}

/// The chunk-relative frame number as an expression of the frame timestamp `t`.
/// (`t` is used instead of `n` because `n` is not evaluated consistently across
/// filters and FFmpeg versions — overlay's position expressions see `n + 1`.)
fn frame_expr(fps: FrameRate) -> String {
    format!("(t*{}/{})", fps.num, fps.den)
}

/// `enable=` for chunk-relative frames `[a, b)`, with half a frame of guard band.
fn enable_expr(fps: FrameRate, a: i64, b: i64) -> String {
    format!(
        "enable='between({},{},{})'",
        frame_expr(fps),
        num(a as f64 - 0.5),
        num(b as f64 - 0.5)
    )
}

/// Ramp progress `clip((frame-a)/len, 0, 1)` in export frames relative to the chunk.
fn ramp_expr(fps: FrameRate, r: &Ramp, chunk_first: i64) -> String {
    let a = fps.ticks_to_frame_round(r.start.0) - chunk_first;
    let len = (fps.ticks_to_frame_round(r.end.0) - chunk_first - a).max(1);
    format!("clip(({}-({a}))/{len},0,1)", frame_expr(fps))
}

fn slide_terms(fps: FrameRate, layer: &Layer, chunk_first: i64) -> Option<String> {
    let mut terms: Vec<String> = Vec::new();
    let term = |s: &Slide, incoming: bool| {
        let p = ramp_expr(
            fps,
            &Ramp {
                start: s.start,
                end: s.end,
            },
            chunk_first,
        );
        if incoming {
            format!("{}*(1-{p})", num(s.dx))
        } else {
            format!("{}*{p}", num(s.dx))
        }
    };
    if let Some(s) = &layer.slide_in {
        terms.push(term(s, true));
    }
    if let Some(s) = &layer.slide_out {
        terms.push(term(s, false));
    }
    if terms.is_empty() {
        None
    } else {
        Some(terms.join("+"))
    }
}

/// Fade ramps that matter for the portion starting at `t_pa` and ending at `t_pb`.
fn active_ramps(layer: &Layer, t_pa: Ticks, t_pb: Ticks) -> (Option<Ramp>, Option<Ramp>) {
    let fin = layer.fade_in.filter(|r| r.end.0 > t_pa && r.end > r.start);
    let fout = layer
        .fade_out
        .filter(|r| r.start.0 < t_pb && r.end > r.start);
    (fin, fout)
}

/// `fade` filters evaluated in a layer-relative, non-negative PTS domain so a ramp
/// that began before the chunk is picked up at the right level.
fn alpha_fades(
    fps: FrameRate,
    layer: &Layer,
    fin: Option<Ramp>,
    fout: Option<Ramp>,
    pa: i64,
    chunk_first: i64,
) -> String {
    // local origin: the earliest of the layer start and the ramps, in frames
    let mut origin = fps.ticks_to_frame_floor(layer.start.0);
    for r in [fin, fout].into_iter().flatten() {
        origin = origin.min(fps.ticks_to_frame_floor(r.start.0));
    }
    let origin = origin.min(pa);
    let origin_ticks = fps.frame_to_ticks(origin);
    let mut s = format!("setpts=PTS-STARTPTS+{}", pa - origin);
    for (r, dir) in [(fin, "in"), (fout, "out")] {
        if let Some(r) = r {
            let _ = write!(
                s,
                ",fade=t={dir}:st={}:d={}:alpha=1",
                secs((r.start.0 - origin_ticks).max(0)),
                secs(r.end - r.start)
            );
        }
    }
    let shift = origin - chunk_first;
    if shift >= 0 {
        let _ = write!(s, ",setpts=PTS+{shift}");
    } else {
        let _ = write!(s, ",setpts=PTS-{}", -shift);
    }
    s
}

struct TextSpec<'a> {
    text: &'a str,
    style: &'a TextStyle,
    scale: f64,
    cy: f64,
}

/// The `drawtext=…` filter (without enable/alpha) for a text block centred on (cx, cy).
fn drawtext_filter(ctx: &Ctx, spec: &TextSpec, file_name: &str, x_expr: &str) -> String {
    let m = text_metrics(
        ctx.settings.height,
        spec.style,
        spec.scale,
        spec.text,
        spec.cy,
    );
    let align = match spec.style.align {
        TextAlign::Left => "L",
        TextAlign::Center => "C",
        TextAlign::Right => "R",
    };
    let mut s = format!(
        "drawtext=fontfile={}:textfile={}:expansion=none:fontsize={}:fontcolor={}:line_spacing=0:y_align=font:text_align={}:x='{}':y={}",
        if spec.style.bold { FONT_BOLD_NAME } else { FONT_REGULAR_NAME },
        file_name,
        m.font_px,
        ff_color(&spec.style.color),
        align,
        x_expr,
        m.block_top
    );
    if let Some(bg) = &spec.style.background {
        let _ = write!(
            s,
            ":box=1:boxcolor={}:boxborderw={}",
            ff_color(bg),
            m.box_padding
        );
    }
    if m.outline_px > 0 {
        let _ = write!(
            s,
            ":borderw={}:bordercolor={}",
            m.outline_px,
            ff_color(&spec.style.outline_color)
        );
    }
    if spec.style.shadow {
        let _ = write!(
            s,
            ":shadowx={0}:shadowy={0}:shadowcolor=0x000000@{1}",
            m.shadow_px,
            num(TEXT_SHADOW_ALPHA)
        );
    }
    s
}

fn add_input(
    inputs: &mut Vec<PlanInput>,
    it: &Item,
    role: InputRole,
    seek: Option<Ticks>,
    limit: Option<Ticks>,
    floor_seek: bool,
) -> usize {
    let src = it.source.expect("media item has a source");
    let idx = inputs.len();
    let mut args = Vec::new();
    if let Some(s) = seek {
        args.push("-ss".to_string());
        args.push(if floor_seek { secs_floor(s) } else { secs(s) });
    }
    if let Some(l) = limit {
        args.push("-t".to_string());
        args.push(secs(l.max(1)));
    }
    args.push("-i".to_string());
    args.push(src.path.clone());
    inputs.push(PlanInput {
        index: idx,
        clip_id: it.clip.id.clone(),
        asset_id: it.clip.asset_id().unwrap_or_default().to_string(),
        role,
        path: src.path.clone(),
        seek,
        limit,
        args,
    });
    idx
}

fn atempo_chain(speed: f64) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut s = speed;
    while s > 2.0 + 1e-9 {
        parts.push("atempo=2".into());
        s /= 2.0;
    }
    while s < 0.5 - 1e-9 {
        parts.push("atempo=0.5".into());
        s /= 0.5;
    }
    if (s - 1.0).abs() > 1e-9 {
        parts.push(format!("atempo={}", num(s)));
    }
    parts.join(",")
}

#[allow(clippy::too_many_arguments)]
fn build_chunk(
    ctx: &Ctx,
    items: &[Item],
    index: usize,
    ca: i64,
    cb: i64,
    export_first: i64,
    samples: i64,
    output_name: &str,
    text_files: &mut BTreeMap<String, String>,
) -> ChunkPlan {
    let fps = ctx.fps;
    let (w, h) = (ctx.settings.width, ctx.settings.height);
    let frames = cb - ca;
    let fr = fps_str(fps);
    let frame_ticks = fps.frame_ticks();
    let mut inputs: Vec<PlanInput> = Vec::new();
    let mut graph: Vec<String> = Vec::new();
    const CS: &str = "out_color_matrix=bt709:out_range=tv";

    graph.push(format!(
        "color=c={}:s={w}x{h}:r={fr},format=rgb24,scale={CS},format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv,trim=end_frame={frames},setsar=1[base]",
        ff_color(&ctx.project.settings.background)
    ));
    let mut cur = "base".to_string();
    let mut step = 0usize;
    let mut audio_labels: Vec<String> = Vec::new();

    for it in items.iter().filter(|it| it.fa < cb && it.fb > ca) {
        let (pa, pb) = (it.fa.max(ca), it.fb.min(cb));
        let (a, b) = (pa - ca, pb - ca); // chunk-relative frames
        let (t_pa, t_pb) = (fps.frame_to_ticks(pa), fps.frame_to_ticks(pb));
        let pd = t_pb - t_pa;
        let enable = enable_expr(fps, a, b);
        let layer = it.layer;
        let tr = &it.clip.transform;
        match it.kind {
            ItemKind::Video | ItemKind::Image => {
                let src = it.source.unwrap();
                let mut chain: Vec<String> = Vec::new();
                let (fin, fout) = active_ramps(layer, t_pa, t_pb);
                let has_fades = fin.is_some() || fout.is_some();
                let input_idx;
                // true when the stream is a single held frame (still image / frozen handle)
                let mut single_frame = false;
                if it.kind == ItemKind::Image {
                    input_idx = add_input(&mut inputs, it, InputRole::Image, None, None, false);
                    chain.push("trim=end_frame=1".into());
                    single_frame = true;
                } else {
                    let d = src.duration.max(frame_ticks);
                    let src_a = layer.source_time_at(TimelineTime(t_pa)).0;
                    let quarter = TICKS_PER_SECOND / 4;
                    if src_a >= d - TICKS_PER_SECOND / 100 {
                        // Entirely past the media (transition handle): hold the last frame.
                        input_idx = add_input(
                            &mut inputs,
                            it,
                            InputRole::Video,
                            Some((d - quarter).max(0)),
                            None,
                            true,
                        );
                        chain.push("reverse".into());
                        chain.push("trim=end_frame=1".into());
                        chain.push("setpts=PTS-STARTPTS".into());
                        single_frame = true;
                    } else {
                        let lead = if src_a < 0 {
                            layer.speed.source_to_output(-src_a).min(pd)
                        } else {
                            0
                        };
                        if lead >= pd {
                            // Entirely before the media: hold the first frame.
                            input_idx = add_input(
                                &mut inputs,
                                it,
                                InputRole::Video,
                                None,
                                Some(TICKS_PER_SECOND / 2),
                                true,
                            );
                            chain.push("trim=end_frame=1".into());
                            chain.push("setpts=PTS-STARTPTS".into());
                            single_frame = true;
                        } else {
                            let mut seek = src_a.max(0);
                            if let Some(sf) = src.fps.and_then(|f| FrameRate::new(f.num, f.den)) {
                                // the source frame that contains this instant (what the preview shows)
                                seek = sf.frame_to_ticks(sf.ticks_to_frame_floor(seek + 1));
                            }
                            let limit = layer.speed.output_to_source(pd - lead) + quarter;
                            input_idx = add_input(
                                &mut inputs,
                                it,
                                InputRole::Video,
                                Some(seek),
                                Some(limit),
                                true,
                            );
                            if layer.speed.is_normal() {
                                chain.push("setpts=PTS-STARTPTS".into());
                            } else {
                                chain.push(format!(
                                    "setpts=(PTS-STARTPTS)*{}/{}",
                                    layer.speed.den, layer.speed.num
                                ));
                            }
                            chain.push(format!("fps={fr}"));
                            if lead > 0 {
                                chain.push(format!(
                                    "tpad=start_mode=clone:start_duration={}",
                                    secs(lead)
                                ));
                            }
                        }
                    }
                }
                // geometry
                let rect = layout_rect(w, h, src.width, src.height, tr);
                let crop = tr.crop;
                if crop.left > 0.0 || crop.top > 0.0 || crop.right > 0.0 || crop.bottom > 0.0 {
                    chain.push(format!(
                        "crop=w=iw*{}:h=ih*{}:x=iw*{}:y=ih*{}",
                        num(1.0 - crop.left - crop.right),
                        num(1.0 - crop.top - crop.bottom),
                        num(crop.left),
                        num(crop.top)
                    ));
                }
                if tr.flip_h {
                    chain.push("hflip".into());
                }
                if tr.flip_v {
                    chain.push("vflip".into());
                }
                let rot = tr.rotation.rem_euclid(360.0);
                let rotated = rot.abs() > 1e-6 && (rot - 360.0).abs() > 1e-6;
                let slide = slide_terms(fps, layer, ca);
                let (mut dw, mut dh) = (rect.dw, rect.dh);
                let mut x0 = (rect.cx - dw as f64 / 2.0).round() as i64;
                let mut y0 = (rect.cy - dh as f64 / 2.0).round() as i64;
                if !rotated && slide.is_none() && (dw > w as i64 || dh > h as i64) {
                    // Zoomed past the frame: only scale the visible part.
                    let vx0 = x0.max(0);
                    let vy0 = y0.max(0);
                    let vx1 = (x0 + dw).min(w as i64);
                    let vy1 = (y0 + dh).min(h as i64);
                    if vx1 > vx0 && vy1 > vy0 {
                        chain.push(format!(
                            "crop=w=iw*{}:h=ih*{}:x=iw*{}:y=ih*{}",
                            num((vx1 - vx0) as f64 / dw as f64),
                            num((vy1 - vy0) as f64 / dh as f64),
                            num((vx0 - x0) as f64 / dw as f64),
                            num((vy0 - y0) as f64 / dh as f64)
                        ));
                        dw = vx1 - vx0;
                        dh = vy1 - vy0;
                        x0 = vx0;
                        y0 = vy0;
                    }
                }
                chain.push(format!("scale={dw}:{dh}:flags=bicubic:{CS}"));
                chain.push("setsar=1".into());
                // colour
                let col = &it.clip.color;
                if !col.is_neutral() {
                    chain.push("format=rgba".into());
                    let per_channel = |temp_gain: f64| {
                        let mut e = "val".to_string();
                        if (temp_gain - 1.0).abs() > 1e-9 {
                            e = format!("clip({e}*{},0,255)", num(temp_gain));
                        }
                        if (col.brightness - 1.0).abs() > 1e-9 {
                            e = format!("clip({e}*{},0,255)", num(col.brightness));
                        }
                        if (col.contrast - 1.0).abs() > 1e-9 {
                            e = format!("clip(({e}-127.5)*{}+127.5,0,255)", num(col.contrast));
                        }
                        e
                    };
                    let (er, eg, eb) = (
                        per_channel(1.0 + 0.25 * col.temperature),
                        per_channel(1.0),
                        per_channel(1.0 - 0.25 * col.temperature),
                    );
                    if er != "val" || eg != "val" || eb != "val" {
                        chain.push(format!("lutrgb=r='{er}':g='{eg}':b='{eb}'"));
                    }
                    if (col.saturation - 1.0).abs() > 1e-9 {
                        let m = color_matrix(col.saturation);
                        chain.push(format!(
                            "colorchannelmixer=rr={}:rg={}:rb={}:gr={}:gg={}:gb={}:br={}:bg={}:bb={}",
                            num(m[0][0]),
                            num(m[0][1]),
                            num(m[0][2]),
                            num(m[1][0]),
                            num(m[1][1]),
                            num(m[1][2]),
                            num(m[2][0]),
                            num(m[2][1]),
                            num(m[2][2])
                        ));
                    }
                    chain.push(format!("scale={CS}"));
                }
                // stills may carry their own transparency (PNG), so they always keep alpha
                let needs_alpha =
                    rotated || has_fades || tr.opacity < 1.0 || it.kind == ItemKind::Image;
                chain.push(if needs_alpha {
                    "format=yuva420p".into()
                } else {
                    "format=yuv420p".into()
                });
                if rotated {
                    let rad = num(rot.to_radians());
                    chain.push(format!(
                        "rotate={rad}:ow=rotw({rad}):oh=roth({rad}):c=black@0"
                    ));
                }
                if tr.opacity < 1.0 {
                    chain.push(format!("lut=a='val*{}'", num(tr.opacity)));
                }
                if single_frame {
                    if has_fades {
                        // fades need a real frame sequence, not one held frame
                        chain.push("loop=loop=-1:size=1:start=0".into());
                        chain.push(format!("fps={fr}"));
                        chain.push(format!("trim=end_frame={}", b - a));
                    } else {
                        chain.push(format!("fps={fr}"));
                    }
                }
                if has_fades {
                    chain.push(alpha_fades(fps, layer, fin, fout, pa, ca));
                } else {
                    chain.push(format!("setpts=PTS-STARTPTS+{a}"));
                }
                let label = format!("v{step}");
                graph.push(format!("[{input_idx}:v]{}[{label}]", chain.join(",")));
                // placement
                let (xs, ys, eval) = if rotated || slide.is_some() {
                    let mut x = format!("{}-w/2", num(rect.cx));
                    if let Some(s) = &slide {
                        let _ = write!(x, "+{w}*({s})");
                    }
                    (format!("'{x}'"), format!("'{}-h/2'", num(rect.cy)), "frame")
                } else {
                    (x0.to_string(), y0.to_string(), "init")
                };
                let out = format!("c{step}");
                graph.push(format!(
                    "[{cur}][{label}]overlay=x={xs}:y={ys}:eval={eval}:{enable}[{out}]"
                ));
                cur = out;
                step += 1;
            }
            ItemKind::Text | ItemKind::Caption => {
                let (text, style, scale, cx, cy, opacity, rot, flip) = match &it.clip.content {
                    ClipContent::Text { text, style } => {
                        let rot = tr.rotation.rem_euclid(360.0);
                        (
                            text.as_str(),
                            style,
                            tr.scale,
                            w as f64 / 2.0 + tr.x * w as f64,
                            h as f64 / 2.0 + tr.y * h as f64,
                            tr.opacity,
                            if rot.abs() > 1e-6 && (rot - 360.0).abs() > 1e-6 {
                                rot
                            } else {
                                0.0
                            },
                            (tr.flip_h, tr.flip_v),
                        )
                    }
                    ClipContent::Caption { text, .. } => {
                        let cs = &ctx.project.settings.caption_style;
                        (
                            text.as_str(),
                            &cs.text,
                            1.0,
                            w as f64 / 2.0,
                            h as f64 / 2.0 + cs.y * h as f64,
                            1.0,
                            0.0,
                            (false, false),
                        )
                    }
                    _ => unreachable!(),
                };
                let clean: String = text
                    .replace("\r\n", "\n")
                    .replace('\r', "\n")
                    .trim_end_matches('\n')
                    .to_string();
                if clean.trim().is_empty() {
                    continue;
                }
                let file_name = format!("text_{}.txt", safe_name(&it.clip.id));
                text_files.insert(file_name.clone(), clean.clone());
                let (fin, fout) = if it.kind == ItemKind::Caption {
                    (None, None)
                } else {
                    active_ramps(layer, t_pa, t_pb)
                };
                let slide = if it.kind == ItemKind::Caption {
                    None
                } else {
                    slide_terms(fps, layer, ca)
                };
                let out = format!("c{step}");
                if rot == 0.0 && !flip.0 && !flip.1 {
                    // straight onto the composite
                    let mut x = format!("{}-text_w/2", num(cx));
                    if let Some(s) = &slide {
                        let _ = write!(x, "+{w}*({s})");
                    }
                    let spec = TextSpec {
                        text: &clean,
                        style,
                        scale,
                        cy,
                    };
                    let mut f = drawtext_filter(ctx, &spec, &file_name, &x);
                    let mut alpha: Vec<String> = Vec::new();
                    if opacity < 1.0 {
                        alpha.push(num(opacity));
                    }
                    if let Some(r) = &fin {
                        alpha.push(ramp_expr(fps, r, ca));
                    }
                    if let Some(r) = &fout {
                        alpha.push(format!("(1-{})", ramp_expr(fps, r, ca)));
                    }
                    if !alpha.is_empty() {
                        let _ = write!(f, ":alpha='{}'", alpha.join("*"));
                    }
                    graph.push(format!("[{cur}]{f}:{enable}[{out}]"));
                } else {
                    // rotated / mirrored text: draw centred on a transparent layer, then
                    // transform and place it like a picture
                    let spec = TextSpec {
                        text: &clean,
                        style,
                        scale,
                        cy: h as f64 / 2.0,
                    };
                    let x = format!("{}-text_w/2", num(w as f64 / 2.0));
                    let mut chain: Vec<String> = vec![
                        format!(
                            "color=c=black@0.0:s={w}x{h}:r={fr},format=rgba,trim=end_frame={}",
                            b - a
                        ),
                        drawtext_filter(ctx, &spec, &file_name, &x),
                    ];
                    if flip.0 {
                        chain.push("hflip".into());
                    }
                    if flip.1 {
                        chain.push("vflip".into());
                    }
                    if rot != 0.0 {
                        chain.push(format!("rotate={}:c=black@0", num(rot.to_radians())));
                    }
                    if opacity < 1.0 {
                        chain.push(format!("colorchannelmixer=aa={}", num(opacity)));
                    }
                    chain.push(format!("scale={CS}"));
                    chain.push("format=yuva420p".into());
                    if fin.is_some() || fout.is_some() {
                        chain.push(alpha_fades(fps, layer, fin, fout, pa, ca));
                    } else {
                        chain.push(format!("setpts=PTS-STARTPTS+{a}"));
                    }
                    let label = format!("v{step}");
                    graph.push(format!("{}[{label}]", chain.join(",")));
                    let mut xs = num(cx - w as f64 / 2.0);
                    if let Some(s) = &slide {
                        let _ = write!(xs, "+{w}*({s})");
                    }
                    graph.push(format!(
                        "[{cur}][{label}]overlay=x='{xs}':y='{}':eval=frame:{enable}[{out}]",
                        num(cy - h as f64 / 2.0)
                    ));
                }
                cur = out;
                step += 1;
            }
            ItemKind::Audio => {
                let src = it.source.unwrap();
                let sr = ctx.sample_rate;
                let sample_at = |f: i64| ticks_to_samples(fps.frame_to_ticks(f), sr);
                let src_a = layer.source_time_at(TimelineTime(t_pa)).0;
                let lead = if src_a < 0 {
                    layer.speed.source_to_output(-src_a).min(pd)
                } else {
                    0
                };
                let seek = src_a.max(0);
                if lead >= pd || seek >= src.duration {
                    continue; // nothing but silence
                }
                let lead_samples = ticks_to_samples(lead, sr);
                let offset = sample_at(pa) - sample_at(ca) + lead_samples;
                let portion_samples = sample_at(pb) - sample_at(pa) - lead_samples;
                if portion_samples <= 0 {
                    continue;
                }
                let limit = layer.speed.output_to_source(pd - lead) + TICKS_PER_SECOND / 4;
                let input_idx = add_input(
                    &mut inputs,
                    it,
                    InputRole::Audio,
                    Some(seek),
                    Some(limit),
                    false,
                );
                let mut chain: Vec<String> = vec![format!("aresample={sr}")];
                if src.channels == Some(1) {
                    chain.push("pan=stereo|c0=c0|c1=c0".into());
                }
                chain.push("aformat=sample_fmts=fltp:channel_layouts=stereo".into());
                let tempo = atempo_chain(layer.speed.as_f64());
                if !tempo.is_empty() {
                    chain.push(tempo);
                }
                chain.push("asetpts=N/SR/TB".into());
                chain.push(format!("atrim=end_sample={portion_samples}"));
                let (fin, fout) = active_ramps(layer, t_pa + lead, t_pb);
                if fin.is_some() || fout.is_some() {
                    // same trick as the picture: evaluate ramps in a non-negative local domain
                    let mut origin = layer.start.0;
                    for r in [fin, fout].into_iter().flatten() {
                        origin = origin.min(r.start.0);
                    }
                    let origin = origin.min(t_pa);
                    let local = ticks_to_samples(t_pa + lead - origin, sr);
                    chain.push(format!("asetpts=(N+{local})/SR/TB"));
                    for (r, dir) in [(fin, "in"), (fout, "out")] {
                        if let Some(r) = r {
                            chain.push(format!(
                                "afade=t={dir}:st={}:d={}:curve=tri",
                                secs((r.start.0 - origin).max(0)),
                                secs(r.end - r.start)
                            ));
                        }
                    }
                    chain.push("asetpts=N/SR/TB".into());
                }
                if offset > 0 {
                    chain.push(format!("adelay=delays={offset}S:all=1"));
                }
                if (layer.gain - 1.0).abs() > 1e-9 {
                    chain.push(format!("volume={}", num(layer.gain)));
                }
                let label = format!("a{}", audio_labels.len());
                graph.push(format!("[{input_idx}:a]{}[{label}]", chain.join(",")));
                audio_labels.push(label);
            }
        }
    }

    // audio bed + mix
    let sr = ctx.sample_rate;
    if audio_labels.is_empty() {
        graph.push(format!("anullsrc=r={sr}:cl=stereo,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=end_sample={samples}[aout]"));
    } else {
        graph.push(format!("anullsrc=r={sr}:cl=stereo,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=end_sample={samples}[bed]"));
        let ins: String = audio_labels.iter().map(|l| format!("[{l}]")).collect();
        graph.push(format!(
            "[bed]{ins}amix=inputs={}:normalize=0:duration=first:dropout_transition=0,atrim=end_sample={samples}[aout]",
            audio_labels.len() + 1
        ));
    }

    let filter_complex = graph.join(";");
    let mut args: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-loglevel",
        "error",
        "-nostats",
        "-progress",
        "pipe:1",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    for i in &inputs {
        args.extend(i.args.iter().cloned());
    }
    args.push("-filter_complex".into());
    args.push(filter_complex.clone());
    args.extend([
        "-map".to_string(),
        format!("[{cur}]"),
        "-map".to_string(),
        "[aout]".to_string(),
        "-frames:v".to_string(),
        frames.to_string(),
    ]);
    args.extend(video_encoder_args(ctx.settings, fps));
    args.extend(["-c:a", "pcm_s24le", "-ar"].iter().map(|s| s.to_string()));
    args.push(sr.to_string());
    args.extend(["-ac", "2", "-f", "nut"].iter().map(|s| s.to_string()));
    args.push(output_name.to_string());

    ChunkPlan {
        index,
        start: TimelineTime(fps.frame_to_ticks(ca)),
        end: TimelineTime(fps.frame_to_ticks(cb)),
        first_frame: ca - export_first,
        frames,
        samples,
        inputs,
        filter_complex,
        args,
        output_name: output_name.to_string(),
    }
}
