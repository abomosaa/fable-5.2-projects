//! Extreme numeric arguments (as a buggy client or a confused AI tool call might
//! send) must be rejected or clamped — never panic, overflow or hang.

mod common;
use common::*;
use cutline_core::commands::{
    ClipDraft, Command, CueDraft, Edge, PlaceMode, SourceCut, SourceRange,
};
use cutline_core::error::ErrorCode;
use cutline_core::model::*;
use cutline_core::time::{SourceTime, Speed, TimelineTime};
use cutline_core::transcript::{Env, SubtitleCue};
use std::sync::Arc;

const EXTREMES: [i64; 8] = [
    i64::MIN,
    i64::MIN + 1,
    -1,
    0,
    1,
    i64::MAX / 2,
    i64::MAX - 1,
    i64::MAX,
];

/// The command either applies cleanly or is rejected with a client error.
fn survives(p: &Project, c: Command) {
    survives_env(p, c, &Env::default());
}

fn survives_env(p: &Project, c: Command, env: &Env) {
    if let Err(e) = try_run_env(p, c.clone(), env) {
        assert_ne!(
            e.code,
            ErrorCode::InvariantViolation,
            "{c:?} tripped an internal invariant: {}",
            e.message
        );
    }
}

fn base() -> (Project, Vec<ClipId>) {
    let (p, ids) = add_range(&project(), "vid", Some(30), Some(100), Some(400));
    let (p, _) = add_range(&p, "vid", None, Some(600), Some(700));
    (p, ids)
}

#[test]
fn extreme_times_and_durations_never_panic() {
    let (p, ids) = base();
    let v1 = track_id(&p, "V1");
    for &x in &EXTREMES {
        let t = TimelineTime(x);
        let s = SourceTime(x);
        survives(
            &p,
            Command::AddAssetClips {
                asset_id: "vid".into(),
                start: Some(t),
                track_id: None,
                source_in: None,
                source_out: None,
                mode: PlaceMode::Overwrite,
            },
        );
        survives(
            &p,
            Command::AddAssetClips {
                asset_id: "vid".into(),
                start: None,
                track_id: None,
                source_in: Some(s),
                source_out: None,
                mode: PlaceMode::Insert,
            },
        );
        survives(
            &p,
            Command::AddAssetClips {
                asset_id: "vid".into(),
                start: None,
                track_id: None,
                source_in: None,
                source_out: Some(s),
                mode: PlaceMode::Overwrite,
            },
        );
        survives(
            &p,
            Command::AddText {
                text: "x".into(),
                start: t,
                duration: None,
                track_id: None,
            },
        );
        survives(
            &p,
            Command::AddText {
                text: "x".into(),
                start: tl(0),
                duration: Some(x),
                track_id: None,
            },
        );
        survives(
            &p,
            Command::AddCaptions {
                cues: vec![CueDraft {
                    start: t,
                    duration: fr(10),
                    text: "c".into(),
                    speaker: None,
                    source: None,
                }],
                track_id: None,
            },
        );
        survives(
            &p,
            Command::AddCaptions {
                cues: vec![CueDraft {
                    start: tl(0),
                    duration: x,
                    text: "c".into(),
                    speaker: None,
                    source: None,
                }],
                track_id: None,
            },
        );
        survives(
            &p,
            Command::MoveClips {
                moves: vec![cutline_core::commands::ClipMove {
                    clip_id: ids[0].clone(),
                    start: t,
                    track_id: v1.clone(),
                }],
                mode: PlaceMode::Overwrite,
            },
        );
        survives(
            &p,
            Command::MoveClips {
                moves: vec![cutline_core::commands::ClipMove {
                    clip_id: ids[0].clone(),
                    start: t,
                    track_id: v1.clone(),
                }],
                mode: PlaceMode::Insert,
            },
        );
        for edge in [Edge::Start, Edge::End] {
            for ripple in [false, true] {
                survives(
                    &p,
                    Command::TrimClips {
                        clip_ids: ids.clone(),
                        edge,
                        delta: x,
                        ripple,
                    },
                );
            }
        }
        survives(
            &p,
            Command::SlipClips {
                clip_ids: ids.clone(),
                delta: x,
            },
        );
        survives(
            &p,
            Command::SplitClips {
                at: t,
                clip_ids: None,
            },
        );
        survives(
            &p,
            Command::RippleDeleteRange {
                start: t,
                end: tl(100),
            },
        );
        survives(
            &p,
            Command::RippleDeleteRange {
                start: tl(0),
                end: t,
            },
        );
        survives(
            &p,
            Command::CloseGap {
                track_id: v1.clone(),
                at: t,
            },
        );
        survives(
            &p,
            Command::AddTransitions {
                left_clip_ids: vec![ids[0].clone()],
                kind: TransitionKind::CrossDissolve,
                duration: x,
            },
        );
        survives(
            &p,
            Command::AddMarker {
                time: t,
                label: String::new(),
                color: None,
            },
        );
        survives(
            &p,
            cmd(
                serde_json::json!({"type": "update_clips", "clip_ids": [ids[0]], "patch": {"fade_in": x}}),
            ),
        );
        survives(
            &p,
            cmd(
                serde_json::json!({"type": "update_clips", "clip_ids": [ids[0]], "patch": {"fade_out": x}}),
            ),
        );
        survives(
            &p,
            Command::RippleDeleteSource {
                cuts: vec![SourceCut {
                    clip_id: ids[1].clone(),
                    source_start: s,
                    source_end: src(200),
                    text: String::new(),
                }],
                reason: RemovalReason::Manual,
            },
        );
        survives(
            &p,
            Command::RippleDeleteSource {
                cuts: vec![SourceCut {
                    clip_id: ids[1].clone(),
                    source_start: src(150),
                    source_end: s,
                    text: String::new(),
                }],
                reason: RemovalReason::Manual,
            },
        );
        survives(
            &p,
            Command::AppendSourceRanges {
                asset_id: "vid".into(),
                ranges: vec![SourceRange {
                    start: s,
                    end: src(50),
                }],
                at: None,
            },
        );
        survives(
            &p,
            Command::AppendSourceRanges {
                asset_id: "vid".into(),
                ranges: vec![SourceRange {
                    start: src(0),
                    end: s,
                }],
                at: Some(t),
            },
        );
        // stills take their duration from the range
        for &y in &EXTREMES {
            survives(
                &p,
                Command::AddAssetClips {
                    asset_id: "img".into(),
                    start: Some(tl(5000)),
                    track_id: None,
                    source_in: Some(s),
                    source_out: Some(SourceTime(y)),
                    mode: PlaceMode::Overwrite,
                },
            );
        }
    }
}

#[test]
fn extreme_transition_updates_and_pastes_never_panic() {
    let (p, ids) = base();
    let p = run(
        &p,
        Command::AddTransitions {
            left_clip_ids: vec![ids[0].clone()],
            kind: TransitionKind::CrossDissolve,
            duration: fr(10),
        },
    );
    let tid = p.transitions.keys().next().unwrap().clone();
    let v1 = track_id(&p, "V1");
    for &x in &EXTREMES {
        survives(
            &p,
            Command::UpdateTransition {
                transition_id: tid.clone(),
                kind: None,
                duration: Some(x),
            },
        );
        let draft = |offset: i64, duration: i64, source_in: i64, fade: i64| ClipDraft {
            track_id: v1.clone(),
            offset,
            duration,
            source_in: SourceTime(source_in),
            speed: Speed::NORMAL,
            content: ClipContent::Video {
                asset_id: "vid".into(),
            },
            enabled: true,
            transform: Transform::default(),
            color: ColorAdjust::default(),
            gain_db: 0.0,
            fade_in: fade,
            fade_out: fade,
            link_key: None,
            group_key: None,
        };
        for mode in [PlaceMode::Overwrite, PlaceMode::Insert] {
            survives(
                &p,
                Command::InsertClips {
                    clips: vec![draft(x, fr(30), 0, 0)],
                    at: tl(2000),
                    mode,
                },
            );
            survives(
                &p,
                Command::InsertClips {
                    clips: vec![draft(0, x, 0, 0)],
                    at: tl(2000),
                    mode,
                },
            );
            survives(
                &p,
                Command::InsertClips {
                    clips: vec![draft(0, fr(30), x, 0)],
                    at: tl(2000),
                    mode,
                },
            );
            survives(
                &p,
                Command::InsertClips {
                    clips: vec![draft(0, fr(30), 0, x)],
                    at: tl(2000),
                    mode,
                },
            );
            survives(
                &p,
                Command::InsertClips {
                    clips: vec![draft(0, fr(30), 0, 0)],
                    at: TimelineTime(x),
                    mode,
                },
            );
        }
        // a still with an absurd source position is harmless
        let mut still = draft(0, fr(30), x, 0);
        still.content = ClipContent::Image {
            asset_id: "img".into(),
        };
        survives(
            &p,
            Command::InsertClips {
                clips: vec![still],
                at: tl(3000),
                mode: PlaceMode::Overwrite,
            },
        );
    }
}

#[test]
fn absurd_subtitle_timestamps_are_survivable() {
    let p = project();
    for &x in &EXTREMES {
        let mut env = Env::default();
        env.subtitles.insert(
            "sub".into(),
            Arc::new(vec![
                SubtitleCue {
                    start_ms: 1000,
                    end_ms: 2000,
                    text: "ok".into(),
                },
                SubtitleCue {
                    start_ms: x,
                    end_ms: 4000,
                    text: "odd start".into(),
                },
                SubtitleCue {
                    start_ms: 5000,
                    end_ms: x,
                    text: "odd end".into(),
                },
            ]),
        );
        survives_env(
            &p,
            Command::AddAssetClips {
                asset_id: "sub".into(),
                start: Some(tl(0)),
                track_id: None,
                source_in: None,
                source_out: None,
                mode: PlaceMode::Overwrite,
            },
            &env,
        );
    }
}

#[test]
fn the_timeline_length_limit_is_a_clean_rejection() {
    let p = project();
    let day = 24 * 3600 * SEC;
    // placing media so that it would end after the 24 h limit
    let near_end = TimelineTime(FPS.snap_floor(day - 10 * SEC));
    let res = try_run(
        &p,
        Command::AddAssetClips {
            asset_id: "vid".into(),
            start: Some(near_end),
            track_id: None,
            source_in: None,
            source_out: None,
            mode: PlaceMode::Overwrite,
        },
    );
    let e = res.expect_err("60 s of media do not fit in the last 10 s");
    assert_ne!(e.code, ErrorCode::InvariantViolation, "{}", e.message);
    // inside the limit it works
    let ok = TimelineTime(FPS.snap_floor(day - 61 * SEC));
    assert!(try_run(
        &p,
        Command::AddAssetClips {
            asset_id: "vid".into(),
            start: Some(ok),
            track_id: None,
            source_in: None,
            source_out: None,
            mode: PlaceMode::Overwrite
        }
    )
    .is_ok());
}
