//! Shared builders and helpers for the core integration tests.
#![allow(dead_code)]

use cutline_core::commands::{apply, Applied, Command};
use cutline_core::error::{CommandError, ErrorCode};
use cutline_core::model::*;
use cutline_core::time::{FrameRate, SourceTime, Ticks, TimelineTime, TICKS_PER_SECOND};
use cutline_core::transcript::{Env, RawToken, Transcript, Word};
use cutline_core::validate;
use serde_json::Value;
use std::sync::Arc;

pub const FPS: FrameRate = FrameRate::FPS_30;
pub const SEC: Ticks = TICKS_PER_SECOND;

/// Ticks of `n` frames at the default 30 fps test rate.
pub fn fr(n: i64) -> Ticks {
    FPS.frame_to_ticks(n)
}
/// Timeline position at frame `n`.
pub fn tl(n: i64) -> TimelineTime {
    TimelineTime(fr(n))
}
/// Source position `n` frames (at 30 fps) into the media.
pub fn src(n: i64) -> SourceTime {
    SourceTime(fr(n))
}
pub fn ms(n: i64) -> Ticks {
    cutline_core::time::ms_to_ticks(n)
}

pub fn asset(
    id: &str,
    kind: AssetKind,
    seconds: i64,
    has_video: bool,
    has_audio: bool,
) -> AssetInfo {
    AssetInfo {
        id: id.into(),
        name: format!("{id}.bin"),
        kind,
        duration: seconds * SEC,
        has_video,
        has_audio,
        width: if has_video { 1920 } else { 0 },
        height: if has_video { 1080 } else { 0 },
        fps: if kind == AssetKind::Video {
            Some(FPS)
        } else {
            None
        },
        sample_rate: if has_audio { Some(48_000) } else { None },
        channels: if has_audio { Some(2) } else { None },
    }
}

/// A fresh project (tracks V2, V1, A1, A2) with a standard media bin:
/// * `vid`  – 60 s video with sound
/// * `vid2` – 30 s video with sound
/// * `mute` – 20 s video without sound
/// * `aud`  – 120 s audio
/// * `img`  – still image
/// * `sub`  – subtitle file
pub fn project() -> Project {
    let mut p = Project::new("p1", "Test project", 1_000);
    for a in [
        asset("vid", AssetKind::Video, 60, true, true),
        asset("vid2", AssetKind::Video, 30, true, true),
        asset("mute", AssetKind::Video, 20, true, false),
        asset("aud", AssetKind::Audio, 120, false, true),
        asset("img", AssetKind::Image, 0, true, false),
        asset("sub", AssetKind::Subtitle, 0, false, false),
    ] {
        cutline_core::commands::add_asset(&mut p, a);
    }
    p
}

/// Parse a command from JSON (also exercises the wire format).
pub fn cmd(v: Value) -> Command {
    serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("bad command {v}: {e}"))
}

pub fn try_run(p: &Project, c: Command) -> Result<Applied, CommandError> {
    try_run_env(p, c, &Env::default())
}

pub fn try_run_env(p: &Project, c: Command, env: &Env) -> Result<Applied, CommandError> {
    let before = p.clone();
    let r = apply(p, &c, env);
    assert_eq!(*p, before, "apply must never mutate its input");
    if let Ok(a) = &r {
        validate::validate(&a.project).expect("committed document must be valid");
        assert_eq!(a.project.revision, p.revision + 1);
        assert_no_overlaps(&a.project);
    }
    r
}

/// Apply a command that must succeed and return the new document.
pub fn run(p: &Project, c: Command) -> Project {
    match try_run(p, c.clone()) {
        Ok(a) => a.project,
        Err(e) => panic!("command {c:?} failed: {e:?}"),
    }
}

pub fn run_env(p: &Project, c: Command, env: &Env) -> Project {
    match try_run_env(p, c.clone(), env) {
        Ok(a) => a.project,
        Err(e) => panic!("command {c:?} failed: {e:?}"),
    }
}

pub fn run_json(p: &Project, v: Value) -> Project {
    run(p, cmd(v))
}

/// Assert that a command is rejected with the given code (and field, when given).
pub fn expect_err(p: &Project, c: Command, code: ErrorCode, field: Option<&str>) -> CommandError {
    expect_err_env(p, c, &Env::default(), code, field)
}

pub fn expect_err_env(
    p: &Project,
    c: Command,
    env: &Env,
    code: ErrorCode,
    field: Option<&str>,
) -> CommandError {
    match try_run_env(p, c.clone(), env) {
        Ok(_) => panic!("command {c:?} unexpectedly succeeded"),
        Err(e) => {
            assert_eq!(e.code, code, "wrong error code for {c:?}: {e:?}");
            if let Some(f) = field {
                assert_eq!(
                    e.field.as_deref(),
                    Some(f),
                    "wrong error field for {c:?}: {e:?}"
                );
            }
            assert!(!e.message.is_empty());
            e
        }
    }
}

pub fn track_id(p: &Project, name: &str) -> TrackId {
    p.tracks
        .iter()
        .find(|t| t.name == name)
        .unwrap_or_else(|| panic!("no track named {name}"))
        .id
        .clone()
}

pub fn track_names(p: &Project) -> Vec<String> {
    p.tracks.iter().map(|t| t.name.clone()).collect()
}

/// Clips of the track called `name`, sorted by start.
pub fn on(p: &Project, name: &str) -> Vec<Clip> {
    p.track_clips(&track_id(p, name))
        .into_iter()
        .cloned()
        .collect()
}

/// `(start_frame, end_frame)` of the clips on a track.
pub fn spans(p: &Project, name: &str) -> Vec<(i64, i64)> {
    on(p, name)
        .iter()
        .map(|c| (frames(c.start.0), frames(c.end().0)))
        .collect()
}

/// `(start_frame, end_frame, source_in_frame)` of the clips on a track.
pub fn spans_src(p: &Project, name: &str) -> Vec<(i64, i64, i64)> {
    on(p, name)
        .iter()
        .map(|c| (frames(c.start.0), frames(c.end().0), frames(c.source_in.0)))
        .collect()
}

/// Exact frame count of a tick value (panics when not frame aligned).
pub fn frames(t: Ticks) -> i64 {
    assert!(FPS.is_aligned(t), "{t} is not frame aligned");
    FPS.ticks_to_frame_floor(t)
}

pub fn ids(clips: &[Clip]) -> Vec<ClipId> {
    clips.iter().map(|c| c.id.clone()).collect()
}

pub fn assert_no_overlaps(p: &Project) {
    for t in &p.tracks {
        let clips = p.track_clips(&t.id);
        for w in clips.windows(2) {
            assert!(
                w[1].start >= w[0].end(),
                "clips {} and {} overlap on {}",
                w[0].id,
                w[1].id,
                t.name
            );
        }
    }
    let fps = p.fps();
    for c in p.clips.values() {
        assert!(
            fps.is_aligned(c.start.0) && fps.is_aligned(c.duration),
            "clip {} is off the frame grid",
            c.id
        );
        assert!(c.duration > 0);
    }
}

/// Add `asset` at frame `start` (None = append) on the default tracks, returning
/// the new document and the ids of the created clips (video first).
pub fn add(p: &Project, asset_id: &str, start: Option<i64>) -> (Project, Vec<ClipId>) {
    add_range(p, asset_id, start, None, None)
}

pub fn add_range(
    p: &Project,
    asset_id: &str,
    start: Option<i64>,
    source_in: Option<i64>,
    source_out: Option<i64>,
) -> (Project, Vec<ClipId>) {
    let a = try_run(
        p,
        Command::AddAssetClips {
            asset_id: asset_id.into(),
            start: start.map(tl),
            track_id: None,
            source_in: source_in.map(src),
            source_out: source_out.map(src),
            mode: Default::default(),
        },
    )
    .expect("add clip");
    (a.project, a.created)
}

/// Document equality ignoring session-managed bookkeeping.
pub fn same_doc(a: &Project, b: &Project) -> bool {
    let mut a = a.clone();
    let mut b = b.clone();
    for p in [&mut a, &mut b] {
        p.revision = 0;
        p.updated_at_ms = 0;
        p.next_id = 0;
    }
    a == b
}

// ---------------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------------

/// Build a transcript from `(text, start_ms, end_ms, speaker)` words. One raw token
/// per word (with the Soniox-style leading space).
pub fn transcript(asset_id: &str, words: &[(&str, i64, i64, &str)]) -> Transcript {
    let mut tokens = Vec::new();
    let mut out = Vec::new();
    let mut speakers: Vec<String> = Vec::new();
    for (i, (text, s, e, sp)) in words.iter().enumerate() {
        tokens.push(RawToken {
            text: format!(" {text}"),
            start_ms: Some(*s),
            end_ms: Some(*e),
            confidence: Some(0.9),
            speaker: Some(sp.to_string()),
            language: Some("en".into()),
        });
        if !speakers.iter().any(|x| x == sp) {
            speakers.push(sp.to_string());
        }
        out.push(Word {
            index: i as u32,
            text: text.to_string(),
            start: SourceTime::from_ms(*s),
            end: SourceTime::from_ms(*e),
            speaker: Some(sp.to_string()),
            language: Some("en".into()),
            confidence: Some(0.9),
            token_start: i as u32,
            token_end: i as u32 + 1,
        });
    }
    Transcript {
        asset_id: asset_id.into(),
        provider: "fixture".into(),
        model: "test".into(),
        fixture: true,
        tokens,
        words: out,
        speakers,
        languages: vec!["en".into()],
    }
}

/// Evenly spaced words: word `i` occupies `[i*step_ms + lead, i*step_ms + lead + len_ms)`.
pub fn even_words<'a>(
    texts: &[&'a str],
    step_ms: i64,
    len_ms: i64,
    speaker: &'a str,
) -> Vec<(&'a str, i64, i64, &'a str)> {
    texts
        .iter()
        .enumerate()
        .map(|(i, t)| (*t, i as i64 * step_ms, i as i64 * step_ms + len_ms, speaker))
        .collect()
}

pub fn env_with(transcripts: Vec<Transcript>) -> Env {
    let mut env = Env::default();
    for t in transcripts {
        env.transcripts.insert(t.asset_id.clone(), Arc::new(t));
    }
    env
}

/// Tiny deterministic PRNG (xorshift64*), so "random" tests are reproducible.
pub struct Rng(pub u64);

impl Rng {
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    /// Uniform-ish integer in `[lo, hi]`.
    pub fn range(&mut self, lo: i64, hi: i64) -> i64 {
        debug_assert!(hi >= lo);
        lo + (self.next() % (hi - lo + 1) as u64) as i64
    }
    pub fn pick<'a, T>(&mut self, v: &'a [T]) -> &'a T {
        &v[self.range(0, v.len() as i64 - 1) as usize]
    }
    pub fn chance(&mut self, percent: i64) -> bool {
        self.range(0, 99) < percent
    }
}
