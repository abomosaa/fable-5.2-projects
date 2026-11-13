//! Delete (lift / ripple), range ripple delete, gap closing and speed changes.

mod common;
use common::*;
use cutline_core::commands::{Command, CueDraft, PlaceMode};
use cutline_core::error::ErrorCode;
use cutline_core::model::*;
use cutline_core::time::Speed;
use serde_json::json;

fn abc() -> (Project, [ClipId; 3]) {
    let (p, a) = add_range(&project(), "mute", Some(0), Some(0), Some(100));
    let (p, b) = add_range(&p, "mute", Some(100), Some(100), Some(200));
    let (p, c) = add_range(&p, "mute", Some(200), Some(200), Some(300));
    (p, [a[0].clone(), b[0].clone(), c[0].clone()])
}

fn del(ids: &[&ClipId], ripple: bool) -> Command {
    Command::DeleteClips {
        clip_ids: ids.iter().map(|s| (*s).clone()).collect(),
        ripple,
    }
}

fn text_on(p: &Project, track: &str, start: i64, len: i64) -> Project {
    let t = track_id(p, track);
    run(
        p,
        Command::AddText {
            text: "T".into(),
            start: tl(start),
            duration: Some(fr(len)),
            track_id: Some(t),
        },
    )
}

fn audio_on(p: &Project, track: &str, start: i64, len: i64) -> Project {
    let t = track_id(p, track);
    run(
        p,
        Command::AddAssetClips {
            asset_id: "aud".into(),
            start: Some(tl(start)),
            track_id: Some(t),
            source_in: None,
            source_out: Some(src(len)),
            mode: PlaceMode::Overwrite,
        },
    )
}

fn lock(p: &Project, track: &str) -> Project {
    let id = track_id(p, track);
    run_json(
        p,
        json!({"type": "update_track", "track_id": id, "locked": true}),
    )
}

fn cue(start: i64, dur: i64, text: &str) -> CueDraft {
    CueDraft {
        start: tl(start),
        duration: fr(dur),
        text: text.into(),
        speaker: None,
        source: None,
    }
}

fn marker_frames(p: &Project) -> Vec<i64> {
    p.markers.iter().map(|m| frames(m.time.0)).collect()
}

// ---------------------------------------------------------------------------------
// DeleteClips
// ---------------------------------------------------------------------------------

#[test]
fn lift_delete_leaves_a_gap() {
    let (p, [_a, b, _c]) = abc();
    let res = try_run(&p, del(&[&b], false)).unwrap();
    assert_eq!(spans(&res.project, "V1"), vec![(0, 100), (200, 300)]);
    assert_eq!(res.label, "Delete clip");
    assert!(res.notices.is_empty());
}

#[test]
fn ripple_delete_closes_the_gap() {
    let (p, [a, b, c]) = abc();
    let res = try_run(&p, del(&[&b], true)).unwrap();
    assert_eq!(
        spans_src(&res.project, "V1"),
        vec![(0, 100, 0), (100, 200, 200)]
    );
    assert_eq!(res.label, "Ripple delete clip");
    assert_eq!(res.project.duration(), fr(200));
    // several separate clips at once
    let q = run(&p, del(&[&a, &c], true));
    assert_eq!(spans_src(&q, "V1"), vec![(0, 100, 100)]);
    // the first clip
    let q = run(&p, del(&[&a], true));
    assert_eq!(spans(&q, "V1"), vec![(0, 100), (100, 200)]);
}

#[test]
fn ripple_delete_keeps_every_track_in_sync() {
    // three linked pairs, a title over the third, music under everything, captions and markers
    let (p, _x) = add_range(&project(), "vid", Some(0), Some(0), Some(100));
    let (p, y) = add_range(&p, "vid", Some(100), Some(100), Some(200));
    let (p, z) = add_range(&p, "vid", Some(200), Some(200), Some(300));
    let p = text_on(&p, "V2", 250, 50);
    let p = audio_on(&p, "A2", 0, 500);
    let p = run(
        &p,
        Command::AddCaptions {
            cues: vec![
                cue(20, 30, "before"),
                cue(120, 30, "inside"),
                cue(210, 30, "after"),
            ],
            track_id: None,
        },
    );
    let mut q = p.clone();
    for t in [50, 150, 250] {
        q = run(
            &q,
            Command::AddMarker {
                time: tl(t),
                label: format!("m{t}"),
                color: None,
            },
        );
    }
    let res = try_run(&q, del(&[&y[0], &y[1]], true)).unwrap();
    let r = res.project;
    assert!(res.notices.is_empty());
    assert_eq!(spans_src(&r, "V1"), vec![(0, 100, 0), (100, 200, 200)]);
    assert_eq!(spans_src(&r, "A1"), vec![(0, 100, 0), (100, 200, 200)]);
    assert_eq!(
        spans(&r, "V2"),
        vec![(150, 200)],
        "the title stays over the same picture"
    );
    assert_eq!(
        spans(&r, "A2"),
        vec![(0, 500)],
        "music spanning the edit is untouched"
    );
    assert_eq!(
        spans(&r, "C1"),
        vec![(20, 50), (110, 140)],
        "captions of the removed stretch go, later ones follow"
    );
    assert_eq!(
        marker_frames(&r),
        vec![50, 150],
        "the marker inside the removed range is dropped, later ones shift"
    );
    assert_eq!(r.clips[&z[0]].sync_anchor(), r.clips[&z[1]].sync_anchor());
}

#[test]
fn ripple_delete_of_overlapping_clips_on_different_tracks_closes_their_union() {
    let (p, v) = add_range(&project(), "mute", Some(0), Some(0), Some(100));
    let p = audio_on(&p, "A1", 50, 150); // 50..200
    let (p, later) = add_range(&p, "mute", Some(300), Some(0), Some(100));
    let a = ids(&on(&p, "A1"))[0].clone();
    let q = run(&p, del(&[&v[0], &a], true));
    assert_eq!(spans(&q, "V1"), vec![(100, 200)]);
    assert_eq!(q.clips[&later[0]].start, tl(100));
}

#[test]
fn ripple_delete_is_limited_by_clips_on_other_tracks_and_says_so() {
    let (p, [_a, b, c]) = abc();
    // V2: a title overlapping B's range, and another title shortly after it
    let p = text_on(&p, "V2", 50, 100); // 50..150
    let p = text_on(&p, "V2", 220, 40); // 220..260
    let res = try_run(&p, del(&[&b], true)).unwrap();
    let q = res.project;
    // V2 only has 70 frames of room (220 - 150): everything moves by 70, in sync
    assert_eq!(spans(&q, "V1"), vec![(0, 100), (130, 230)]);
    assert_eq!(spans(&q, "V2"), vec![(50, 150), (150, 190)]);
    assert_eq!(q.clips[&c].start, tl(130));
    assert_eq!(res.notices.len(), 1);

    // no room at all: the clip is still deleted, nothing moves
    let (p, [_a, b, _c]) = abc();
    let p = text_on(&p, "V2", 50, 160); // 50..210
    let p = text_on(&p, "V2", 210, 40); // 210..250
    let res = try_run(&p, del(&[&b], true)).unwrap();
    assert_eq!(spans(&res.project, "V1"), vec![(0, 100), (200, 300)]);
    assert_eq!(spans(&res.project, "V2"), vec![(50, 210), (210, 250)]);
    assert_eq!(res.notices.len(), 1);
}

#[test]
fn ripple_delete_never_moves_locked_tracks() {
    let (p, [_a, b, _c]) = abc();
    let p = audio_on(&p, "A2", 250, 100);
    let p = lock(&p, "A2");
    let q = run(&p, del(&[&b], true));
    assert_eq!(spans(&q, "V1"), vec![(0, 100), (100, 200)]);
    assert_eq!(spans(&q, "A2"), vec![(250, 350)]);
}

#[test]
fn delete_validation_and_side_effects() {
    let (p, [a, b, _c]) = abc();
    expect_err(
        &p,
        Command::DeleteClips {
            clip_ids: vec![],
            ripple: false,
        },
        ErrorCode::InvalidArgument,
        Some("clip_ids"),
    );
    expect_err(
        &p,
        Command::DeleteClips {
            clip_ids: vec!["ghost".into()],
            ripple: true,
        },
        ErrorCode::NotFound,
        None,
    );
    // one bad id rejects the whole command
    expect_err(
        &p,
        Command::DeleteClips {
            clip_ids: vec![a.clone(), "ghost".into()],
            ripple: false,
        },
        ErrorCode::NotFound,
        None,
    );
    let locked = lock(&p, "V1");
    expect_err(&locked, del(&[&a], false), ErrorCode::TrackLocked, None);
    // duplicates in the id list are harmless
    let q = run(
        &p,
        Command::DeleteClips {
            clip_ids: vec![a.clone(), a.clone()],
            ripple: false,
        },
    );
    assert_eq!(q.clips.len(), 2);
    // a transition on a deleted clip disappears with it
    let t = run(
        &p,
        Command::AddTransitions {
            left_clip_ids: vec![a.clone()],
            kind: TransitionKind::CrossDissolve,
            duration: fr(10),
        },
    );
    assert_eq!(t.transitions.len(), 1);
    assert!(run(&t, del(&[&b], false)).transitions.is_empty());
    // deleting half of a linked pair unlinks the survivor
    let (lp, pair) = add(&project(), "vid", Some(0));
    let q = run(&lp, del(&[&pair[0]], false));
    assert!(q.clips[&pair[1]].link_id.is_none());
}

// ---------------------------------------------------------------------------------
// RippleDeleteRange
// ---------------------------------------------------------------------------------

#[test]
fn range_ripple_delete_cuts_the_range_out_of_every_track() {
    let (p, _) = add(&project(), "vid", Some(0));
    let p = audio_on(&p, "A2", 0, 500);
    let p = text_on(&p, "V2", 100, 200); // 100..300
    let p = text_on(&p, "V2", 450, 50); // 450..500
    let mut q = p.clone();
    for t in [100, 300, 400, 900] {
        q = run(
            &q,
            Command::AddMarker {
                time: tl(t),
                label: String::new(),
                color: None,
            },
        );
    }
    let r = run(
        &q,
        Command::RippleDeleteRange {
            start: tl(200),
            end: tl(400),
        },
    );
    assert_eq!(spans_src(&r, "V1"), vec![(0, 200, 0), (200, 1600, 400)]);
    assert_eq!(spans_src(&r, "A1"), vec![(0, 200, 0), (200, 1600, 400)]);
    assert_eq!(spans_src(&r, "A2"), vec![(0, 200, 0), (200, 300, 400)]);
    assert_eq!(spans(&r, "V2"), vec![(100, 200), (250, 300)]);
    assert_eq!(
        marker_frames(&r),
        vec![100, 200, 700],
        "markers inside vanish; the one at the range end lands on the cut"
    );
    assert_eq!(r.duration(), fr(1600));
    // both sides of the cut are proper linked pairs
    let (v, a) = (on(&r, "V1"), on(&r, "A1"));
    assert_eq!(v[0].link_id, a[0].link_id);
    assert_eq!(v[1].link_id, a[1].link_id);
    assert!(v[1].link_id.is_some());
    assert_ne!(v[0].link_id, v[1].link_id);
}

#[test]
fn range_ripple_delete_validation_and_locked_tracks() {
    let (p, _) = add(&project(), "vid", Some(0));
    expect_err(
        &p,
        Command::RippleDeleteRange {
            start: tl(100),
            end: tl(100),
        },
        ErrorCode::InvalidArgument,
        Some("end"),
    );
    expect_err(
        &p,
        Command::RippleDeleteRange {
            start: tl(100),
            end: tl(50),
        },
        ErrorCode::InvalidArgument,
        Some("end"),
    );
    expect_err(
        &p,
        Command::RippleDeleteRange {
            start: tl(-5),
            end: tl(50),
        },
        ErrorCode::InvalidArgument,
        Some("start"),
    );
    let locked = lock(&p, "A1");
    let q = run(
        &locked,
        Command::RippleDeleteRange {
            start: tl(0),
            end: tl(300),
        },
    );
    assert_eq!(spans_src(&q, "V1"), vec![(0, 1500, 300)]);
    assert_eq!(spans_src(&q, "A1"), vec![(0, 1800, 0)]);
}

// ---------------------------------------------------------------------------------
// CloseGap
// ---------------------------------------------------------------------------------

#[test]
fn close_gap_pulls_later_material_left_on_all_tracks() {
    let (p, _) = add_range(&project(), "mute", Some(0), Some(0), Some(100));
    let (p, _) = add_range(&p, "mute", Some(250), Some(0), Some(100));
    let p = audio_on(&p, "A1", 300, 60);
    let v1 = track_id(&p, "V1");
    let q = run(
        &p,
        Command::CloseGap {
            track_id: v1.clone(),
            at: tl(180),
        },
    );
    assert_eq!(spans(&q, "V1"), vec![(0, 100), (100, 200)]);
    assert_eq!(spans(&q, "A1"), vec![(150, 210)]);
    // a gap at the head of the timeline
    let (h, _) = add_range(&project(), "mute", Some(90), Some(0), Some(100));
    let q = run(
        &h,
        Command::CloseGap {
            track_id: v1.clone(),
            at: tl(10),
        },
    );
    assert_eq!(spans(&q, "V1"), vec![(0, 100)]);
}

#[test]
fn close_gap_rejections_and_partial_close() {
    let (p, _) = add_range(&project(), "mute", Some(0), Some(0), Some(100));
    let (p, _) = add_range(&p, "mute", Some(250), Some(0), Some(100));
    let v1 = track_id(&p, "V1");
    expect_err(
        &p,
        Command::CloseGap {
            track_id: v1.clone(),
            at: tl(50),
        },
        ErrorCode::Conflict,
        None,
    );
    expect_err(
        &p,
        Command::CloseGap {
            track_id: v1.clone(),
            at: tl(400),
        },
        ErrorCode::Conflict,
        None,
    );
    expect_err(
        &p,
        Command::CloseGap {
            track_id: "ghost".into(),
            at: tl(150),
        },
        ErrorCode::NotFound,
        None,
    );
    expect_err(
        &lock(&p, "V1"),
        Command::CloseGap {
            track_id: v1.clone(),
            at: tl(150),
        },
        ErrorCode::TrackLocked,
        None,
    );
    // another track only leaves 30 frames of room
    let blocked = audio_on(&p, "A1", 0, 220);
    let blocked = audio_on(&blocked, "A1", 250, 50);
    let res = try_run(
        &blocked,
        Command::CloseGap {
            track_id: v1.clone(),
            at: tl(150),
        },
    )
    .unwrap();
    assert_eq!(spans(&res.project, "V1"), vec![(0, 100), (220, 320)]);
    assert_eq!(spans(&res.project, "A1"), vec![(0, 220), (220, 270)]);
    assert_eq!(res.notices.len(), 1);
    // …and none at all is an error, not a silent no-op
    let stuck = audio_on(&p, "A1", 0, 250);
    let stuck = audio_on(&stuck, "A1", 250, 50);
    expect_err(
        &stuck,
        Command::CloseGap {
            track_id: v1,
            at: tl(150),
        },
        ErrorCode::Conflict,
        None,
    );
}

// ---------------------------------------------------------------------------------
// SetSpeed
// ---------------------------------------------------------------------------------

fn speed(ids: &[ClipId], speed: f64, ripple: bool) -> Command {
    Command::SetSpeed {
        clip_ids: ids.to_vec(),
        speed,
        ripple,
    }
}

/// Two linked pairs: X 0..300 (source 0..300) and Y 300..400.
fn two_pairs() -> (Project, Vec<ClipId>, Vec<ClipId>) {
    let (p, x) = add_range(&project(), "vid", Some(0), Some(0), Some(300));
    let (p, y) = add_range(&p, "vid", Some(300), Some(600), Some(700));
    (p, x, y)
}

#[test]
fn faster_speed_shortens_the_clip_and_ripples() {
    let (p, x, y) = two_pairs();
    let res = try_run(&p, speed(&x, 2.0, true)).unwrap();
    let q = res.project;
    assert_eq!(res.label, "Change speed to 2×");
    for id in &x {
        let c = &q.clips[id];
        assert_eq!(
            (c.start, c.duration, c.source_in, c.source_out()),
            (tl(0), fr(150), src(0), src(300))
        );
        assert_eq!(c.speed, Speed::new(2, 1).unwrap());
    }
    for id in &y {
        assert_eq!(q.clips[id].start, tl(150));
    }
    assert_eq!(q.duration(), fr(250));
}

#[test]
fn slower_speed_lengthens_the_clip_and_pushes_later_material() {
    let (p, x, y) = two_pairs();
    let q = run(&p, speed(&x, 0.5, true));
    for id in &x {
        assert_eq!(
            (q.clips[id].duration, q.clips[id].source_out()),
            (fr(600), src(300))
        );
    }
    for id in &y {
        assert_eq!(q.clips[id].start, tl(600));
    }
    // the common presets give exact durations
    for (s, frames_out) in [
        (1.5, 200),
        (3.0, 100),
        (0.25, 1200),
        (0.75, 400),
        (1.25, 240),
    ] {
        let q = run(&p, speed(&x, s, true));
        assert_eq!(q.clips[&x[0]].duration, fr(frames_out), "speed {s}");
        assert_eq!(q.clips[&x[1]].duration, fr(frames_out));
        assert_eq!(q.clips[&y[0]].start, tl(frames_out));
    }
}

#[test]
fn without_ripple_the_clip_stays_inside_its_slot() {
    let (p, x, y) = two_pairs();
    // slower: no room to grow, so less source is shown
    let q = run(&p, speed(&x, 0.5, false));
    for id in &x {
        let c = &q.clips[id];
        assert_eq!(
            (c.duration, c.source_in, c.source_out()),
            (fr(300), src(0), src(150))
        );
    }
    assert_eq!(q.clips[&y[0]].start, tl(300));
    // faster: a gap opens, nothing moves
    let q = run(&p, speed(&x, 2.0, false));
    assert_eq!(q.clips[&x[0]].duration, fr(150));
    assert_eq!(q.clips[&y[0]].start, tl(300));
    // slower with free space after it simply grows
    let q = run(&p, speed(&y, 0.5, false));
    assert_eq!(q.clips[&y[0]].end(), tl(500));
}

#[test]
fn changing_several_consecutive_clips_at_once_keeps_them_in_order() {
    let (p, x, y) = two_pairs();
    let all: Vec<ClipId> = x.iter().chain(y.iter()).cloned().collect();
    let q = run(&p, speed(&all, 0.5, true));
    assert_eq!(spans(&q, "V1"), vec![(0, 600), (600, 800)]);
    assert_eq!(spans(&q, "A1"), vec![(0, 600), (600, 800)]);
    let q = run(&p, speed(&all, 2.0, true));
    assert_eq!(spans(&q, "V1"), vec![(0, 150), (150, 200)]);
    // without ripple the first clip is held by the second, the second grows freely
    let q = run(&p, speed(&all, 0.5, false));
    assert_eq!(spans(&q, "V1"), vec![(0, 300), (300, 500)]);
    assert_eq!(spans(&q, "A1"), vec![(0, 300), (300, 500)]);
}

#[test]
fn odd_speeds_keep_linked_clips_aligned_and_inside_the_media() {
    let (p, pair) = add(&project(), "vid", Some(0));
    for s in [0.3, 0.7, 1.1, 1.333, 2.7, 9.99, 16.0, 0.1] {
        let q = run(&p, speed(&pair, s, true));
        let (v, a) = (&q.clips[&pair[0]], &q.clips[&pair[1]]);
        assert_eq!((v.start, v.duration), (a.start, a.duration), "speed {s}");
        assert_eq!(v.sync_anchor(), a.sync_anchor());
        let expected = FPS.snap(Speed::from_f64(s).unwrap().source_to_output(fr(1800)));
        assert_eq!(v.duration, expected);
        // Back to normal: never longer than the media, and at most the frame-rounding
        // loss (half an output frame at speed s == s/2 source frames) shorter.
        let back = run(&q, speed(&pair, 1.0, true)).clips[&pair[0]].duration;
        assert!(back <= fr(1800), "speed {s} grew past the media");
        assert!(
            fr(1800) - back <= fr((s / 2.0).ceil() as i64 + 1),
            "speed {s} lost too much: {back}"
        );
    }
}

#[test]
fn speed_validation() {
    let (p, pair) = add(&project(), "vid", Some(0));
    for bad in [0.0, 0.05, 16.5, -1.0, f64::NAN, f64::INFINITY] {
        expect_err(
            &p,
            speed(&pair, bad, true),
            ErrorCode::InvalidArgument,
            Some("speed"),
        );
    }
    expect_err(
        &p,
        speed(&[], 2.0, true),
        ErrorCode::InvalidArgument,
        Some("clip_ids"),
    );
    expect_err(
        &lock(&p, "A1"),
        speed(&pair, 2.0, true),
        ErrorCode::TrackLocked,
        None,
    );
    let (pi, img) = add(&project(), "img", Some(0));
    expect_err(&pi, speed(&img, 2.0, true), ErrorCode::Conflict, None);
    let pt = run(
        &project(),
        Command::AddText {
            text: "x".into(),
            start: tl(0),
            duration: None,
            track_id: None,
        },
    );
    let t = ids(&on(&pt, "V2"));
    expect_err(&pt, speed(&t, 2.0, true), ErrorCode::Conflict, None);
}

#[test]
fn speed_ripple_respects_blockers_on_other_tracks() {
    let (p, x, y) = two_pairs();
    // a title over the end of X and the start of Y blocks nothing on its own track,
    // but a second title right behind it limits how far things can close up
    let p = text_on(&p, "V2", 280, 40); // 280..320
    let p = text_on(&p, "V2", 330, 30); // 330..360
    let res = try_run(&p, speed(&x, 2.0, true));
    let q = res.unwrap().project;
    // X now ends at 150; V2 allows only 10 frames (330 - 320) of closing
    assert_eq!(q.clips[&x[0]].duration, fr(150));
    assert_eq!(q.clips[&y[0]].start, tl(290));
    assert_eq!(spans(&q, "V2"), vec![(280, 320), (320, 350)]);
}
