//! Commands that put material on the timeline: asset clips, text, captions,
//! paste / duplicate, and the overwrite / insert placement semantics.

mod common;
use common::*;
use cutline_core::commands::{ClipDraft, Command, CueDraft, PlaceMode};
use cutline_core::error::ErrorCode;
use cutline_core::model::*;
use cutline_core::time::{SourceTime, Speed};
use cutline_core::transcript::{Env, SubtitleCue};
use serde_json::json;
use std::sync::Arc;

fn add_cmd(asset: &str, start: Option<i64>, track: Option<&str>, mode: PlaceMode) -> Command {
    Command::AddAssetClips {
        asset_id: asset.into(),
        start: start.map(tl),
        track_id: track.map(str::to_string),
        source_in: None,
        source_out: None,
        mode,
    }
}

// ---------------------------------------------------------------------------------
// AddAssetClips
// ---------------------------------------------------------------------------------

#[test]
fn video_with_sound_becomes_a_linked_pair_on_v1_and_a1() {
    let (p, created) = add(&project(), "vid", Some(0));
    assert_eq!(created.len(), 2);
    let (v, a) = (&p.clips[&created[0]], &p.clips[&created[1]]);
    assert_eq!(
        v.content,
        ClipContent::Video {
            asset_id: "vid".into()
        }
    );
    assert_eq!(
        a.content,
        ClipContent::Audio {
            asset_id: "vid".into()
        }
    );
    assert_eq!(v.track_id, track_id(&p, "V1"));
    assert_eq!(a.track_id, track_id(&p, "A1"));
    assert_eq!(
        (v.start, v.duration, v.source_in),
        (tl(0), fr(1800), src(0))
    );
    assert_eq!(
        (a.start, a.duration, a.source_in),
        (tl(0), fr(1800), src(0))
    );
    assert!(v.link_id.is_some());
    assert_eq!(v.link_id, a.link_id);
    assert_eq!(v.speed, Speed::NORMAL);
    assert!(v.enabled && v.transform.is_identity() && v.color.is_neutral());
    assert_eq!(p.duration(), fr(1800));
    assert!(spans(&p, "V2").is_empty() && spans(&p, "A2").is_empty());
}

#[test]
fn start_none_appends_after_the_longest_target_track() {
    let (p, _) = add(&project(), "aud", Some(0)); // A1: 0..3600
    let (p, _) = add(&p, "mute", None); // V1 only: 0..600
    assert_eq!(spans(&p, "V1"), vec![(0, 600)]);
    let (p, created) = add(&p, "vid2", None); // needs V1 and A1 → after the audio
    assert_eq!(p.clips[&created[0]].start, tl(3600));
    assert_eq!(p.clips[&created[1]].start, tl(3600));
    assert_eq!(spans(&p, "V1"), vec![(0, 600), (3600, 4500)]);
    assert_eq!(spans(&p, "A1"), vec![(0, 3600), (3600, 4500)]);
}

#[test]
fn audio_only_silent_video_and_image_assets() {
    let (p, created) = add(&project(), "aud", Some(30));
    assert_eq!(created.len(), 1);
    assert_eq!(spans(&p, "A1"), vec![(30, 3630)]);
    assert!(p.clips[&created[0]].link_id.is_none());
    assert!(spans(&p, "V1").is_empty());

    let (p, created) = add(&project(), "mute", Some(0));
    assert_eq!(created.len(), 1);
    assert_eq!(spans(&p, "V1"), vec![(0, 600)]);
    assert!(spans(&p, "A1").is_empty());
    assert!(p.clips[&created[0]].link_id.is_none());

    let (p, created) = add(&project(), "img", Some(10));
    assert_eq!(created.len(), 1);
    let c = &p.clips[&created[0]];
    assert_eq!(
        c.content,
        ClipContent::Image {
            asset_id: "img".into()
        }
    );
    assert_eq!((c.start, c.duration), (tl(10), DEFAULT_STILL_DURATION));
    assert_eq!(c.source_in, SourceTime::ZERO);
    // an explicit range sets the still's duration
    let (p, created) = add_range(&project(), "img", Some(0), Some(0), Some(45));
    assert_eq!(p.clips[&created[0]].duration, fr(45));
}

#[test]
fn source_range_selects_part_of_the_media() {
    let (p, created) = add_range(&project(), "vid", Some(60), Some(300), Some(450));
    for id in &created {
        let c = &p.clips[id];
        assert_eq!(
            (c.start, c.duration, c.source_in, c.source_out()),
            (tl(60), fr(150), src(300), src(450))
        );
    }
    // off-grid source ranges keep their exact in point; the duration floors to frames
    let p0 = project();
    let a = try_run(
        &p0,
        Command::AddAssetClips {
            asset_id: "vid".into(),
            start: Some(tl(0)),
            track_id: None,
            source_in: Some(SourceTime(fr(10) + 5)),
            source_out: Some(SourceTime(fr(40) + 4)),
            mode: PlaceMode::Overwrite,
        },
    )
    .unwrap();
    let c = &a.project.clips[&a.created[0]];
    assert_eq!(c.source_in, SourceTime(fr(10) + 5));
    assert_eq!(c.duration, fr(29));
}

#[test]
fn source_range_validation() {
    let p = project();
    let mk = |i: i64, o: i64| Command::AddAssetClips {
        asset_id: "vid".into(),
        start: Some(tl(0)),
        track_id: None,
        source_in: Some(src(i)),
        source_out: Some(src(o)),
        mode: PlaceMode::Overwrite,
    };
    expect_err(
        &p,
        mk(-1, 10),
        ErrorCode::InvalidArgument,
        Some("source_in"),
    );
    expect_err(
        &p,
        mk(1801, 1900),
        ErrorCode::InvalidArgument,
        Some("source_in"),
    );
    expect_err(
        &p,
        mk(100, 100),
        ErrorCode::InvalidArgument,
        Some("source_out"),
    );
    expect_err(
        &p,
        mk(100, 50),
        ErrorCode::InvalidArgument,
        Some("source_out"),
    );
    expect_err(
        &p,
        mk(0, 1900),
        ErrorCode::InvalidArgument,
        Some("source_out"),
    );
    expect_err(
        &p,
        add_cmd("nope", Some(0), None, PlaceMode::Overwrite),
        ErrorCode::NotFound,
        None,
    );
    let neg = Command::AddAssetClips {
        asset_id: "vid".into(),
        start: Some(tl(-1)),
        track_id: None,
        source_in: None,
        source_out: None,
        mode: PlaceMode::Overwrite,
    };
    expect_err(&p, neg, ErrorCode::InvalidArgument, Some("start"));
}

#[test]
fn off_grid_start_is_snapped_to_the_nearest_frame() {
    let p = project();
    let c = Command::AddAssetClips {
        asset_id: "mute".into(),
        start: Some(cutline_core::TimelineTime(fr(10) + fr(1) / 2 + 1)),
        track_id: None,
        source_in: None,
        source_out: None,
        mode: PlaceMode::Overwrite,
    };
    let p = run(&p, c);
    assert_eq!(spans(&p, "V1"), vec![(11, 611)]);
}

#[test]
fn explicit_track_pairs_video_n_with_audio_n() {
    let p = project();
    let v2 = track_id(&p, "V2");
    let a2 = track_id(&p, "A2");
    let q = run(&p, add_cmd("vid", Some(0), Some(&v2), PlaceMode::Overwrite));
    assert_eq!(spans(&q, "V2"), vec![(0, 1800)]);
    assert_eq!(spans(&q, "A2"), vec![(0, 1800)]);
    assert!(spans(&q, "V1").is_empty() && spans(&q, "A1").is_empty());
    // dropping on the audio track mirrors to the matching video track
    let q = run(&p, add_cmd("vid", Some(0), Some(&a2), PlaceMode::Overwrite));
    assert_eq!(spans(&q, "V2"), vec![(0, 1800)]);
    assert_eq!(spans(&q, "A2"), vec![(0, 1800)]);
    // audio on A2 only
    let q = run(&p, add_cmd("aud", Some(0), Some(&a2), PlaceMode::Overwrite));
    assert_eq!(spans(&q, "A2"), vec![(0, 3600)]);
}

#[test]
fn wrong_track_kind_is_rejected() {
    let p = project();
    let v1 = track_id(&p, "V1");
    let a1 = track_id(&p, "A1");
    expect_err(
        &p,
        add_cmd("aud", Some(0), Some(&v1), PlaceMode::Overwrite),
        ErrorCode::InvalidArgument,
        Some("track_id"),
    );
    expect_err(
        &p,
        add_cmd("img", Some(0), Some(&a1), PlaceMode::Overwrite),
        ErrorCode::InvalidArgument,
        Some("track_id"),
    );
    expect_err(
        &p,
        add_cmd("mute", Some(0), Some(&a1), PlaceMode::Overwrite),
        ErrorCode::InvalidArgument,
        Some("track_id"),
    );
    expect_err(
        &p,
        add_cmd("vid", Some(0), Some("missing"), PlaceMode::Overwrite),
        ErrorCode::NotFound,
        None,
    );
    let with_captions = run(
        &p,
        Command::AddCaptions {
            cues: vec![cue(0, 30, "hi")],
            track_id: None,
        },
    );
    let c1 = track_id(&with_captions, "C1");
    expect_err(
        &with_captions,
        add_cmd("vid", Some(0), Some(&c1), PlaceMode::Overwrite),
        ErrorCode::InvalidArgument,
        Some("track_id"),
    );
}

#[test]
fn locked_tracks_are_never_written_to() {
    let p = project();
    let v1 = track_id(&p, "V1");
    let locked = run_json(
        &p,
        json!({"type": "update_track", "track_id": v1, "locked": true}),
    );
    // explicit target: rejected
    expect_err(
        &locked,
        add_cmd("vid", Some(0), Some(&v1), PlaceMode::Overwrite),
        ErrorCode::TrackLocked,
        None,
    );
    // automatic target: the next unlocked video track is used
    let q = run(&locked, add_cmd("vid", Some(0), None, PlaceMode::Overwrite));
    assert!(spans(&q, "V1").is_empty());
    assert_eq!(spans(&q, "V2"), vec![(0, 1800)]);
    assert_eq!(spans(&q, "A1"), vec![(0, 1800)]);
    // every video track locked: a new one is created on top
    let v2 = track_id(&p, "V2");
    let all_locked = run_json(
        &locked,
        json!({"type": "update_track", "track_id": v2, "locked": true}),
    );
    let q = run(
        &all_locked,
        add_cmd("mute", Some(0), None, PlaceMode::Overwrite),
    );
    assert_eq!(track_names(&q), vec!["V3", "V2", "V1", "A1", "A2"]);
    assert_eq!(spans(&q, "V3"), vec![(0, 600)]);
}

#[test]
fn asset_without_streams_is_a_conflict() {
    let mut p = project();
    cutline_core::commands::add_asset(&mut p, asset("empty", AssetKind::Video, 10, false, false));
    expect_err(
        &p,
        add_cmd("empty", Some(0), None, PlaceMode::Overwrite),
        ErrorCode::Conflict,
        None,
    );
}

// ---------------------------------------------------------------------------------
// Overwrite semantics
// ---------------------------------------------------------------------------------

/// V1 holds one 20 s silent clip at frames 100..700 (source 0..600).
fn base_clip() -> (Project, ClipId) {
    let (p, ids) = add(&project(), "mute", Some(100));
    (p, ids[0].clone())
}

fn place_img(p: &Project, start: i64, len: i64) -> Project {
    run(
        p,
        Command::AddAssetClips {
            asset_id: "img".into(),
            start: Some(tl(start)),
            track_id: None,
            source_in: Some(src(0)),
            source_out: Some(src(len)),
            mode: PlaceMode::Overwrite,
        },
    )
}

#[test]
fn overwrite_covering_a_clip_removes_it() {
    let (p, id) = base_clip();
    let q = place_img(&p, 50, 700);
    assert_eq!(spans(&q, "V1"), vec![(50, 750)]);
    assert!(!q.clips.contains_key(&id));
    // exact cover
    let q = place_img(&p, 100, 600);
    assert_eq!(spans(&q, "V1"), vec![(100, 700)]);
    assert!(!q.clips.contains_key(&id));
}

#[test]
fn overwrite_trims_the_tail_of_an_earlier_clip() {
    let (p, id) = base_clip();
    let q = place_img(&p, 400, 600);
    assert_eq!(spans_src(&q, "V1"), vec![(100, 400, 0), (400, 1000, 0)]);
    assert_eq!(q.clips[&id].source_out(), src(300));
}

#[test]
fn overwrite_trims_the_head_of_a_later_clip_and_advances_source_in() {
    let (p, id) = base_clip();
    let q = place_img(&p, 0, 250);
    assert_eq!(spans(&q, "V1"), vec![(0, 250), (250, 700)]);
    let c = &q.clips[&id];
    assert_eq!(
        c.source_in,
        src(150),
        "the head trim must skip the hidden source"
    );
    assert_eq!(c.source_out(), src(600));
}

#[test]
fn overwrite_inside_a_clip_splits_it_around_the_range() {
    let (p, id) = base_clip();
    let q = place_img(&p, 300, 100);
    assert_eq!(
        spans_src(&q, "V1"),
        vec![(100, 300, 0), (300, 400, 0), (400, 700, 300)]
    );
    let clips = on(&q, "V1");
    assert_eq!(clips[0].id, id, "the left part keeps the original id");
    assert_ne!(clips[2].id, id);
    assert_eq!(
        clips[2].content,
        ClipContent::Video {
            asset_id: "mute".into()
        }
    );
    assert_eq!(clips[2].source_out(), src(600));
}

#[test]
fn overwrite_respects_speed_when_adjusting_source() {
    let (p, id) = base_clip();
    let p = run(
        &p,
        Command::SetSpeed {
            clip_ids: vec![id.clone()],
            speed: 2.0,
            ripple: true,
        },
    );
    assert_eq!(spans(&p, "V1"), vec![(100, 400)]);
    let q = place_img(&p, 0, 200); // hides the first 100 output frames = 200 source frames
    assert_eq!(q.clips[&id].source_in, src(200));
    assert_eq!(q.clips[&id].source_out(), src(600));
}

#[test]
fn overwrite_splitting_a_linked_pair_links_the_right_halves_to_each_other() {
    let (p, ids) = add(&project(), "vid", Some(0));
    let original_link = p.clips[&ids[0]].link_id.clone().unwrap();
    let q = run(&p, add_cmd("vid2", Some(300), None, PlaceMode::Overwrite));
    assert_eq!(spans(&q, "V1"), vec![(0, 300), (300, 1200), (1200, 1800)]);
    assert_eq!(spans(&q, "A1"), vec![(0, 300), (300, 1200), (1200, 1800)]);
    let (v, a) = (on(&q, "V1"), on(&q, "A1"));
    // left halves keep the original link
    assert_eq!(v[0].link_id.as_deref(), Some(original_link.as_str()));
    assert_eq!(a[0].link_id, v[0].link_id);
    // the new clip is its own pair
    assert_eq!(v[1].link_id, a[1].link_id);
    assert!(v[1].link_id.is_some());
    // right halves are linked to each other but no longer to the left halves
    assert_eq!(v[2].link_id, a[2].link_id);
    assert!(v[2].link_id.is_some());
    assert_ne!(v[2].link_id, v[0].link_id);
    assert_ne!(v[2].link_id, v[1].link_id);
}

#[test]
fn overwrite_on_one_track_leaves_the_linked_companion_intact() {
    let (p, ids) = add(&project(), "vid", Some(0));
    let q = place_img(&p, 300, 100); // V1 only
    assert_eq!(spans(&q, "V1"), vec![(0, 300), (300, 400), (400, 1800)]);
    assert_eq!(spans(&q, "A1"), vec![(0, 1800)]);
    let v = on(&q, "V1");
    assert_eq!(
        v[0].link_id, q.clips[&ids[1]].link_id,
        "left part stays linked to the untouched audio"
    );
    assert!(
        v[2].link_id.is_none(),
        "a lone right-hand piece is unlinked"
    );
}

// ---------------------------------------------------------------------------------
// Insert (ripple) placement
// ---------------------------------------------------------------------------------

#[test]
fn insert_mode_splits_everything_at_the_point_and_ripples_all_tracks() {
    let (p, ids) = add(&project(), "vid", Some(0)); // V1 + A1 0..1800
                                                    // music on A2 so three tracks are involved
    let a2 = track_id(&p, "A2");
    let p = run(
        &p,
        Command::AddAssetClips {
            asset_id: "aud".into(),
            start: Some(tl(0)),
            track_id: Some(a2),
            source_in: None,
            source_out: Some(src(900)),
            mode: PlaceMode::Overwrite,
        },
    );
    let q = run(&p, add_cmd("vid2", Some(600), None, PlaceMode::Insert));
    assert_eq!(
        spans_src(&q, "V1"),
        vec![(0, 600, 0), (600, 1500, 0), (1500, 2700, 600)]
    );
    assert_eq!(
        spans_src(&q, "A1"),
        vec![(0, 600, 0), (600, 1500, 0), (1500, 2700, 600)]
    );
    assert_eq!(
        spans_src(&q, "A2"),
        vec![(0, 600, 0), (1500, 1800, 600)],
        "music is split and stays in sync"
    );
    assert_eq!(q.duration(), fr(2700));
    // link structure: left pair, inserted pair and right pair are three separate links
    let (v, a) = (on(&q, "V1"), on(&q, "A1"));
    for i in 0..3 {
        assert!(v[i].link_id.is_some());
        assert_eq!(v[i].link_id, a[i].link_id);
    }
    assert_ne!(v[0].link_id, v[2].link_id);
    assert_eq!(v[0].id, ids[0]);
}

#[test]
fn insert_at_a_cut_does_not_split_anything() {
    let (p, _) = add(&project(), "mute", Some(0));
    let (p, _) = add(&p, "mute", None);
    let q = run(&p, add_cmd("img", Some(600), None, PlaceMode::Insert));
    assert_eq!(spans(&q, "V1"), vec![(0, 600), (600, 750), (750, 1350)]);
    assert_eq!(q.clips.len(), 3);
}

#[test]
fn insert_does_not_move_locked_tracks() {
    let (p, _) = add(&project(), "vid", Some(0));
    let a1 = track_id(&p, "A1");
    let p = run_json(
        &p,
        json!({"type": "update_track", "track_id": a1, "locked": true}),
    );
    let q = run(&p, add_cmd("img", Some(300), None, PlaceMode::Insert));
    assert_eq!(spans(&q, "V1"), vec![(0, 300), (300, 450), (450, 1950)]);
    assert_eq!(
        spans(&q, "A1"),
        vec![(0, 1800)],
        "locked audio is untouched"
    );
}

// ---------------------------------------------------------------------------------
// Subtitle assets
// ---------------------------------------------------------------------------------

#[test]
fn subtitle_asset_becomes_caption_clips() {
    let p = project();
    expect_err(
        &p,
        add_cmd("sub", Some(0), None, PlaceMode::Overwrite),
        ErrorCode::Conflict,
        None,
    );
    let mut env = Env::default();
    env.subtitles.insert(
        "sub".into(),
        Arc::new(vec![
            SubtitleCue {
                start_ms: 1000,
                end_ms: 2500,
                text: "Hello there".into(),
            },
            SubtitleCue {
                start_ms: 2400,
                end_ms: 4000,
                text: "  General Kenobi \n".into(),
            },
            SubtitleCue {
                start_ms: 5000,
                end_ms: 5000,
                text: "blink".into(),
            },
            SubtitleCue {
                start_ms: 6000,
                end_ms: 7000,
                text: "   ".into(),
            },
        ]),
    );
    let q = run_env(
        &p,
        add_cmd("sub", Some(30), None, PlaceMode::Overwrite),
        &env,
    );
    assert_eq!(track_names(&q)[0], "C1");
    let caps = on(&q, "C1");
    assert_eq!(caps.len(), 3, "blank cues are skipped");
    // file time is offset by the drop position (frame 30 = 1 s); overlapping cues do not overlap on the track
    assert_eq!(spans(&q, "C1"), vec![(60, 105), (105, 150), (180, 181)]);
    match &caps[1].content {
        ClipContent::Caption {
            text,
            generated,
            source,
            ..
        } => {
            assert_eq!(text, "General Kenobi");
            assert!(!generated);
            assert!(source.is_none());
        }
        other => panic!("unexpected {other:?}"),
    }
    // empty subtitle files are reported
    env.subtitles.insert("sub".into(), Arc::new(vec![]));
    expect_err_env(
        &p,
        add_cmd("sub", Some(0), None, PlaceMode::Overwrite),
        &env,
        ErrorCode::Conflict,
        None,
    );
}

// ---------------------------------------------------------------------------------
// Text and captions
// ---------------------------------------------------------------------------------

fn cue(start: i64, dur: i64, text: &str) -> CueDraft {
    CueDraft {
        start: tl(start),
        duration: fr(dur),
        text: text.into(),
        speaker: None,
        source: None,
    }
}

#[test]
fn text_goes_above_v1_and_stacks_onto_new_tracks_when_busy() {
    let p = project();
    let q = run(
        &p,
        Command::AddText {
            text: "Title".into(),
            start: tl(0),
            duration: None,
            track_id: None,
        },
    );
    assert_eq!(spans(&q, "V2"), vec![(0, 150)]);
    match &on(&q, "V2")[0].content {
        ClipContent::Text { text, style } => {
            assert_eq!(text, "Title");
            assert_eq!(*style, TextStyle::default());
        }
        other => panic!("unexpected {other:?}"),
    }
    // overlapping second title: V2 is busy → new top track
    let q2 = run(
        &q,
        Command::AddText {
            text: "Sub".into(),
            start: tl(60),
            duration: Some(fr(30)),
            track_id: None,
        },
    );
    assert_eq!(track_names(&q2), vec!["V3", "V2", "V1", "A1", "A2"]);
    assert_eq!(spans(&q2, "V3"), vec![(60, 90)]);
    // non-overlapping title reuses V2
    let q3 = run(
        &q,
        Command::AddText {
            text: "Later".into(),
            start: tl(150),
            duration: Some(fr(30)),
            track_id: None,
        },
    );
    assert_eq!(spans(&q3, "V2"), vec![(0, 150), (150, 180)]);
    // explicit track overwrites what is there
    let v2 = track_id(&q, "V2");
    let q4 = run(
        &q,
        Command::AddText {
            text: "Replace".into(),
            start: tl(30),
            duration: Some(fr(60)),
            track_id: Some(v2),
        },
    );
    assert_eq!(spans(&q4, "V2"), vec![(0, 30), (30, 90), (90, 150)]);
}

#[test]
fn text_validation() {
    let p = project();
    let a1 = track_id(&p, "A1");
    expect_err(
        &p,
        Command::AddText {
            text: "  \n ".into(),
            start: tl(0),
            duration: None,
            track_id: None,
        },
        ErrorCode::InvalidArgument,
        Some("text"),
    );
    expect_err(
        &p,
        Command::AddText {
            text: "x".repeat(2001),
            start: tl(0),
            duration: None,
            track_id: None,
        },
        ErrorCode::InvalidArgument,
        Some("text"),
    );
    expect_err(
        &p,
        Command::AddText {
            text: "bell\u{7}".into(),
            start: tl(0),
            duration: None,
            track_id: None,
        },
        ErrorCode::InvalidArgument,
        Some("text"),
    );
    expect_err(
        &p,
        Command::AddText {
            text: "ok".into(),
            start: tl(-5),
            duration: None,
            track_id: None,
        },
        ErrorCode::InvalidArgument,
        Some("start"),
    );
    expect_err(
        &p,
        Command::AddText {
            text: "ok".into(),
            start: tl(0),
            duration: None,
            track_id: Some(a1),
        },
        ErrorCode::InvalidArgument,
        Some("track_id"),
    );
    // multi-line text is fine; tiny durations are raised to one frame
    let q = run(
        &p,
        Command::AddText {
            text: "two\nlines".into(),
            start: tl(0),
            duration: Some(1),
            track_id: None,
        },
    );
    assert_eq!(spans(&q, "V2"), vec![(0, 1)]);
}

#[test]
fn captions_create_the_caption_track_on_top_and_never_overlap() {
    let p = project();
    let q = run(
        &p,
        Command::AddCaptions {
            cues: vec![
                cue(100, 60, "second"),
                cue(0, 120, " first "),
                cue(200, 30, "third"),
            ],
            track_id: None,
        },
    );
    assert_eq!(track_names(&q), vec!["C1", "V2", "V1", "A1", "A2"]);
    assert_eq!(q.tracks[0].kind, TrackKind::Caption);
    assert_eq!(
        spans(&q, "C1"),
        vec![(0, 100), (100, 160), (200, 230)],
        "the earlier cue is trimmed where they overlap"
    );
    match &on(&q, "C1")[0].content {
        ClipContent::Caption {
            text, generated, ..
        } => {
            assert_eq!(text, "first");
            assert!(!generated);
        }
        other => panic!("unexpected {other:?}"),
    }
    // adding again reuses C1 and overwrites what is underneath
    let q2 = run(
        &q,
        Command::AddCaptions {
            cues: vec![cue(90, 30, "over")],
            track_id: None,
        },
    );
    assert_eq!(
        track_names(&q2)
            .iter()
            .filter(|n| n.starts_with('C'))
            .count(),
        1
    );
    assert_eq!(
        spans(&q2, "C1"),
        vec![(0, 90), (90, 120), (120, 160), (200, 230)]
    );
}

#[test]
fn caption_validation() {
    let p = project();
    let v1 = track_id(&p, "V1");
    expect_err(
        &p,
        Command::AddCaptions {
            cues: vec![],
            track_id: None,
        },
        ErrorCode::InvalidArgument,
        Some("cues"),
    );
    expect_err(
        &p,
        Command::AddCaptions {
            cues: vec![cue(0, 30, "  ")],
            track_id: None,
        },
        ErrorCode::InvalidArgument,
        Some("cues.text"),
    );
    expect_err(
        &p,
        Command::AddCaptions {
            cues: vec![cue(0, 30, &"x".repeat(501))],
            track_id: None,
        },
        ErrorCode::InvalidArgument,
        Some("cues.text"),
    );
    expect_err(
        &p,
        Command::AddCaptions {
            cues: vec![cue(0, 30, "a")],
            track_id: Some(v1),
        },
        ErrorCode::InvalidArgument,
        Some("track_id"),
    );
    expect_err(
        &p,
        Command::AddCaptions {
            cues: vec![cue(-1, 30, "a")],
            track_id: None,
        },
        ErrorCode::InvalidArgument,
        Some("cues.start"),
    );
    // two cues starting on the same frame cannot both exist
    expect_err(
        &p,
        Command::AddCaptions {
            cues: vec![cue(10, 30, "a"), cue(10, 30, "b")],
            track_id: None,
        },
        ErrorCode::InvalidArgument,
        Some("cues"),
    );
    // a failed caption command must not leave a caption track behind
    assert_eq!(track_names(&p).len(), 4);
}

// ---------------------------------------------------------------------------------
// InsertClips (paste) and DuplicateClips
// ---------------------------------------------------------------------------------

fn draft(p: &Project, track: &str, offset: i64, dur: i64, content: ClipContent) -> ClipDraft {
    ClipDraft {
        track_id: track_id(p, track),
        offset: fr(offset),
        duration: fr(dur),
        source_in: SourceTime::ZERO,
        speed: Speed::NORMAL,
        content,
        enabled: true,
        transform: Transform::default(),
        color: ColorAdjust::default(),
        gain_db: 0.0,
        fade_in: 0,
        fade_out: 0,
        link_key: None,
        group_key: None,
    }
}

fn video(asset: &str) -> ClipContent {
    ClipContent::Video {
        asset_id: asset.into(),
    }
}
fn audio(asset: &str) -> ClipContent {
    ClipContent::Audio {
        asset_id: asset.into(),
    }
}

#[test]
fn paste_places_drafts_relative_to_the_anchor_and_remaps_links_and_groups() {
    let p = project();
    let mut v = draft(&p, "V1", 0, 90, video("vid"));
    let mut a = draft(&p, "A1", 0, 90, audio("vid"));
    let mut b = draft(&p, "V1", 120, 30, video("mute"));
    for d in [&mut v, &mut a] {
        d.link_key = Some("clipboard-link".into());
        d.group_key = Some("G".into());
    }
    b.group_key = Some("G".into());
    v.source_in = src(300);
    a.source_in = src(300);
    v.transform.scale = 0.5;
    a.gain_db = -6.0;
    v.fade_in = fr(10);
    let res = try_run(
        &p,
        Command::InsertClips {
            clips: vec![v, a, b],
            at: tl(60),
            mode: PlaceMode::Overwrite,
        },
    )
    .unwrap();
    let q = res.project;
    assert_eq!(res.created.len(), 3);
    assert_eq!(spans_src(&q, "V1"), vec![(60, 150, 300), (180, 210, 0)]);
    assert_eq!(spans_src(&q, "A1"), vec![(60, 150, 300)]);
    let (pv, pa, pb) = (&on(&q, "V1")[0], &on(&q, "A1")[0], &on(&q, "V1")[1]);
    assert_eq!(pv.link_id, pa.link_id);
    assert!(pv.link_id.is_some());
    assert_ne!(
        pv.link_id.as_deref(),
        Some("clipboard-link"),
        "link keys are remapped to fresh ids"
    );
    assert!(pb.link_id.is_none());
    assert_eq!(pv.group_id, pb.group_id);
    assert_eq!(pv.group_id, pa.group_id);
    assert_ne!(pv.group_id.as_deref(), Some("G"));
    assert_eq!(pv.transform.scale, 0.5);
    assert_eq!(pa.gain_db, -6.0);
    assert_eq!(pv.fade_in, fr(10));
    // pasting twice yields independent links
    let again = run(
        &q,
        Command::InsertClips {
            clips: vec![
                draft(&p, "V2", 0, 30, video("vid")),
                draft(&p, "A2", 0, 30, audio("vid")),
            ]
            .into_iter()
            .map(|mut d| {
                d.link_key = Some("clipboard-link".into());
                d
            })
            .collect(),
            at: tl(0),
            mode: PlaceMode::Overwrite,
        },
    );
    assert_ne!(on(&again, "V2")[0].link_id, pv.link_id);
}

#[test]
fn paste_overwrites_or_inserts() {
    let (p, _) = add(&project(), "mute", Some(0)); // V1 0..600
    let d = draft(&p, "V1", 0, 60, video("mute"));
    let over = run(
        &p,
        Command::InsertClips {
            clips: vec![d.clone()],
            at: tl(300),
            mode: PlaceMode::Overwrite,
        },
    );
    assert_eq!(
        spans_src(&over, "V1"),
        vec![(0, 300, 0), (300, 360, 0), (360, 600, 360)]
    );
    let ins = run(
        &p,
        Command::InsertClips {
            clips: vec![d],
            at: tl(300),
            mode: PlaceMode::Insert,
        },
    );
    assert_eq!(
        spans_src(&ins, "V1"),
        vec![(0, 300, 0), (300, 360, 0), (360, 660, 300)]
    );
}

#[test]
fn paste_clamps_duration_to_the_available_media() {
    let p = project();
    let mut d = draft(&p, "V1", 0, 3000, video("vid2")); // 100 s requested, 30 s media
    d.source_in = src(300);
    let q = run(
        &p,
        Command::InsertClips {
            clips: vec![d.clone()],
            at: tl(0),
            mode: PlaceMode::Overwrite,
        },
    );
    assert_eq!(spans_src(&q, "V1"), vec![(0, 600, 300)]);
    d.speed = Speed::new(2, 1).unwrap();
    let q = run(
        &p,
        Command::InsertClips {
            clips: vec![d],
            at: tl(0),
            mode: PlaceMode::Overwrite,
        },
    );
    assert_eq!(spans(&q, "V1"), vec![(0, 300)]);
}

#[test]
fn paste_validation() {
    let p = project();
    let ok = draft(&p, "V1", 0, 30, video("vid"));
    let paste = |d: Vec<ClipDraft>| Command::InsertClips {
        clips: d,
        at: tl(0),
        mode: PlaceMode::Overwrite,
    };
    expect_err(&p, paste(vec![]), ErrorCode::InvalidArgument, Some("clips"));
    expect_err(
        &p,
        paste(vec![draft(&p, "A1", 0, 30, video("vid"))]),
        ErrorCode::InvalidArgument,
        Some("clips.track_id"),
    );
    expect_err(
        &p,
        paste(vec![draft(&p, "V1", 0, 30, audio("vid"))]),
        ErrorCode::InvalidArgument,
        Some("clips.track_id"),
    );
    expect_err(
        &p,
        paste(vec![draft(&p, "V1", 0, 30, video("ghost"))]),
        ErrorCode::NotFound,
        None,
    );
    expect_err(
        &p,
        paste(vec![draft(&p, "V1", 0, 0, video("vid"))]),
        ErrorCode::InvalidArgument,
        Some("clips.duration"),
    );
    expect_err(
        &p,
        paste(vec![draft(&p, "V1", -1, 30, video("vid"))]),
        ErrorCode::InvalidArgument,
        Some("clips.offset"),
    );
    expect_err(
        &p,
        paste(vec![draft(&p, "V1", 0, 30, video("aud"))]),
        ErrorCode::InvalidArgument,
        Some("clips.content"),
    );
    expect_err(
        &p,
        paste(vec![draft(&p, "V1", 0, 30, video("img"))]),
        ErrorCode::InvalidArgument,
        Some("clips.content"),
    );
    expect_err(
        &p,
        paste(vec![draft(&p, "A1", 0, 30, audio("mute"))]),
        ErrorCode::InvalidArgument,
        Some("clips.content"),
    );
    expect_err(
        &p,
        paste(vec![draft(
            &p,
            "V1",
            0,
            30,
            ClipContent::Image {
                asset_id: "vid".into(),
            },
        )]),
        ErrorCode::InvalidArgument,
        Some("clips.content"),
    );
    let mut d = ok.clone();
    d.source_in = src(1800);
    expect_err(
        &p,
        paste(vec![d]),
        ErrorCode::InvalidArgument,
        Some("clips.source_in"),
    );
    let mut d = ok.clone();
    d.speed = Speed { num: 100, den: 1 };
    expect_err(
        &p,
        paste(vec![d]),
        ErrorCode::InvalidArgument,
        Some("clips.speed"),
    );
    let mut d = ok.clone();
    d.transform.scale = 0.0;
    expect_err(
        &p,
        paste(vec![d]),
        ErrorCode::InvalidArgument,
        Some("scale"),
    );
    let mut d = ok.clone();
    d.color.contrast = 9.0;
    expect_err(
        &p,
        paste(vec![d]),
        ErrorCode::InvalidArgument,
        Some("contrast"),
    );
    // drafts that overlap each other
    expect_err(
        &p,
        paste(vec![ok.clone(), draft(&p, "V1", 10, 30, video("vid"))]),
        ErrorCode::InvalidArgument,
        Some("clips"),
    );
    // locked target
    let v1 = track_id(&p, "V1");
    let locked = run_json(
        &p,
        json!({"type": "update_track", "track_id": v1, "locked": true}),
    );
    expect_err(&locked, paste(vec![ok]), ErrorCode::TrackLocked, None);
}

#[test]
fn duplicate_places_copies_right_after_the_selection() {
    let (p, ids) = add_range(&project(), "vid", Some(0), Some(0), Some(300));
    let res = try_run(
        &p,
        Command::DuplicateClips {
            clip_ids: ids.clone(),
        },
    )
    .unwrap();
    let q = res.project;
    assert_eq!(res.created.len(), 2);
    assert_eq!(spans_src(&q, "V1"), vec![(0, 300, 0), (300, 600, 0)]);
    assert_eq!(spans_src(&q, "A1"), vec![(0, 300, 0), (300, 600, 0)]);
    let (v, a) = (on(&q, "V1"), on(&q, "A1"));
    assert_eq!(v[1].link_id, a[1].link_id);
    assert!(v[1].link_id.is_some());
    assert_ne!(
        v[1].link_id, v[0].link_id,
        "the copy is its own linked pair"
    );
    assert_eq!(v[0].id, ids[0]);
}

#[test]
fn duplicate_skips_ahead_to_the_first_free_space_and_never_overwrites() {
    let (p, a) = add_range(&project(), "mute", Some(0), Some(0), Some(100));
    let (p, _) = add_range(&p, "mute", Some(100), Some(0), Some(50));
    let (p, _) = add_range(&p, "mute", Some(200), Some(0), Some(50));
    // 100 frames do not fit in 150..200, so the copy lands after the last clip
    let q = run(
        &p,
        Command::DuplicateClips {
            clip_ids: a.clone(),
        },
    );
    assert_eq!(
        spans(&q, "V1"),
        vec![(0, 100), (100, 150), (200, 250), (250, 350)]
    );
    assert_eq!(q.clips.len(), 4);
    // a shorter clip fits into the hole
    let b = ids(&on(&p, "V1"))[1].clone();
    let q = run(&p, Command::DuplicateClips { clip_ids: vec![b] });
    assert_eq!(
        spans(&q, "V1"),
        vec![(0, 100), (100, 150), (150, 200), (200, 250)]
    );
}

#[test]
fn duplicate_keeps_relative_offsets_properties_and_groups() {
    let (p, v) = add_range(&project(), "mute", Some(0), Some(0), Some(100));
    let (p, a) = add_range(&p, "aud", Some(50), Some(0), Some(150));
    let both = vec![v[0].clone(), a[0].clone()];
    let p = run(
        &p,
        Command::GroupClips {
            clip_ids: both.clone(),
        },
    );
    let p = run_json(
        &p,
        json!({"type": "update_clips", "clip_ids": [v[0]], "patch": {"scale": 0.4, "x": 0.2, "brightness": 1.3, "fade_in": fr(6)}}),
    );
    let p = run_json(
        &p,
        json!({"type": "set_speed", "clip_ids": [a[0]], "speed": 1.5, "ripple": true}),
    );
    assert_eq!(spans(&p, "A1"), vec![(50, 150)]);
    let q = run(&p, Command::DuplicateClips { clip_ids: both });
    assert_eq!(spans(&q, "V1"), vec![(0, 100), (150, 250)]);
    assert_eq!(spans(&q, "A1"), vec![(50, 150), (200, 300)]);
    let (cv, ca) = (&on(&q, "V1")[1], &on(&q, "A1")[1]);
    assert_eq!(cv.transform.scale, 0.4);
    assert_eq!(cv.transform.x, 0.2);
    assert_eq!(cv.color.brightness, 1.3);
    assert_eq!(cv.fade_in, fr(6));
    assert_eq!(ca.speed, Speed::new(3, 2).unwrap());
    assert_eq!(ca.source_duration(), fr(150));
    assert_eq!(cv.group_id, ca.group_id);
    assert!(cv.group_id.is_some());
    assert_ne!(cv.group_id, on(&q, "V1")[0].group_id);
}

#[test]
fn duplicate_validation() {
    let (p, ids) = add(&project(), "mute", Some(0));
    expect_err(
        &p,
        Command::DuplicateClips { clip_ids: vec![] },
        ErrorCode::InvalidArgument,
        Some("clip_ids"),
    );
    expect_err(
        &p,
        Command::DuplicateClips {
            clip_ids: vec!["nope".into()],
        },
        ErrorCode::NotFound,
        None,
    );
    let v1 = track_id(&p, "V1");
    let locked = run_json(
        &p,
        json!({"type": "update_track", "track_id": v1, "locked": true}),
    );
    expect_err(
        &locked,
        Command::DuplicateClips { clip_ids: ids },
        ErrorCode::TrackLocked,
        None,
    );
}
