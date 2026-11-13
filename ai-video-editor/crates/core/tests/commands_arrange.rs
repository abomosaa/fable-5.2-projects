//! Arranging commands: move (overwrite + shuffle insert), trim, ripple trim, slip, split.

mod common;
use common::*;
use cutline_core::commands::{ClipMove, Command, Edge, PlaceMode};
use cutline_core::error::ErrorCode;
use cutline_core::model::*;
use cutline_core::TimelineTime;
use serde_json::json;

fn mv(id: &str, start: i64, track: &str) -> ClipMove {
    ClipMove {
        clip_id: id.into(),
        start: tl(start),
        track_id: track.into(),
    }
}

fn move_cmd(moves: Vec<ClipMove>) -> Command {
    Command::MoveClips {
        moves,
        mode: PlaceMode::Overwrite,
    }
}

fn shuffle_cmd(moves: Vec<ClipMove>) -> Command {
    Command::MoveClips {
        moves,
        mode: PlaceMode::Insert,
    }
}

fn lock(p: &Project, track: &str) -> Project {
    let id = track_id(p, track);
    run_json(
        p,
        json!({"type": "update_track", "track_id": id, "locked": true}),
    )
}

/// Three silent clips on V1: A 0..100, B 100..200, C 200..300 (source == timeline position).
fn abc() -> (Project, [ClipId; 3]) {
    let (p, a) = add_range(&project(), "mute", Some(0), Some(0), Some(100));
    let (p, b) = add_range(&p, "mute", Some(100), Some(100), Some(200));
    let (p, c) = add_range(&p, "mute", Some(200), Some(200), Some(300));
    (p, [a[0].clone(), b[0].clone(), c[0].clone()])
}

fn order(p: &Project, track: &str) -> Vec<ClipId> {
    ids(&on(p, track))
}

// ---------------------------------------------------------------------------------
// MoveClips
// ---------------------------------------------------------------------------------

#[test]
fn move_changes_position_and_track_but_not_source() {
    let (p, ids) = add_range(&project(), "mute", Some(0), Some(30), Some(130));
    let v1 = track_id(&p, "V1");
    let v2 = track_id(&p, "V2");
    let q = run(&p, move_cmd(vec![mv(&ids[0], 250, &v1)]));
    assert_eq!(spans_src(&q, "V1"), vec![(250, 350, 30)]);
    let q = run(&q, move_cmd(vec![mv(&ids[0], 10, &v2)]));
    assert!(spans(&q, "V1").is_empty());
    assert_eq!(spans_src(&q, "V2"), vec![(10, 110, 30)]);
    // overlapping its own old position is fine
    let q = run(&q, move_cmd(vec![mv(&ids[0], 15, &v2)]));
    assert_eq!(spans(&q, "V2"), vec![(15, 115)]);
    // off-grid targets snap
    let off = ClipMove {
        clip_id: ids[0].clone(),
        start: TimelineTime(fr(40) + 3),
        track_id: v2.clone(),
    };
    let q = run(&q, move_cmd(vec![off]));
    assert_eq!(spans(&q, "V2"), vec![(40, 140)]);
}

#[test]
fn move_overwrites_what_it_lands_on() {
    let (p, [a, b, c]) = abc();
    let v1 = track_id(&p, "V1");
    // A (100 long) dropped at 150: trims B's tail, covers nothing of C… then C's head
    let q = run(&p, move_cmd(vec![mv(&a, 150, &v1)]));
    assert_eq!(
        spans_src(&q, "V1"),
        vec![(100, 150, 100), (150, 250, 0), (250, 300, 250)]
    );
    assert_eq!(order(&q, "V1"), vec![b.clone(), a.clone(), c.clone()]);
    // dropped exactly over B: B disappears
    let q = run(&p, move_cmd(vec![mv(&a, 100, &v1)]));
    assert_eq!(order(&q, "V1"), vec![a.clone(), c.clone()]);
    assert_eq!(spans(&q, "V1"), vec![(100, 200), (200, 300)]);
    // a short clip dropped inside a long one splits it around
    let (p2, long) = add(&project(), "mute", Some(0));
    let (p2, short) = add_range(&p2, "mute", Some(1000), Some(0), Some(50));
    let q = run(&p2, move_cmd(vec![mv(&short[0], 200, &v1)]));
    assert_eq!(
        spans_src(&q, "V1"),
        vec![(0, 200, 0), (200, 250, 0), (250, 600, 250)]
    );
    assert_eq!(on(&q, "V1")[0].id, long[0]);
}

#[test]
fn moving_several_clips_at_once_can_swap_them() {
    let (p, [a, b, c]) = abc();
    let v1 = track_id(&p, "V1");
    let q = run(&p, move_cmd(vec![mv(&a, 100, &v1), mv(&b, 0, &v1)]));
    assert_eq!(order(&q, "V1"), vec![b.clone(), a.clone(), c.clone()]);
    assert_eq!(spans(&q, "V1"), vec![(0, 100), (100, 200), (200, 300)]);
    assert_eq!(q.clips.len(), 3, "moved clips never overwrite each other");
}

#[test]
fn linked_pair_moves_together_and_stays_in_sync() {
    let (p, ids) = add_range(&project(), "vid", Some(0), Some(60), Some(160));
    let (v2, a2) = (track_id(&p, "V2"), track_id(&p, "A2"));
    let q = run(
        &p,
        move_cmd(vec![mv(&ids[0], 90, &v2), mv(&ids[1], 90, &a2)]),
    );
    assert_eq!(spans_src(&q, "V2"), vec![(90, 190, 60)]);
    assert_eq!(spans_src(&q, "A2"), vec![(90, 190, 60)]);
    assert_eq!(
        q.clips[&ids[0]].sync_anchor(),
        q.clips[&ids[1]].sync_anchor()
    );
    assert_eq!(q.clips[&ids[0]].link_id, q.clips[&ids[1]].link_id);
    // moving only the audio (linked selection off) is allowed and shows up as a sync offset
    let a1 = track_id(&p, "A1");
    let q = run(&p, move_cmd(vec![mv(&ids[1], 5, &a1)]));
    assert_eq!(
        q.clips[&ids[1]].sync_anchor() - q.clips[&ids[0]].sync_anchor(),
        fr(5)
    );
    assert_eq!(
        q.clips[&ids[0]].link_id, q.clips[&ids[1]].link_id,
        "still linked, just out of sync"
    );
}

#[test]
fn move_validation() {
    let (p, [a, b, _c]) = abc();
    let (v1, v2, a1) = (track_id(&p, "V1"), track_id(&p, "V2"), track_id(&p, "A1"));
    expect_err(
        &p,
        move_cmd(vec![]),
        ErrorCode::InvalidArgument,
        Some("moves"),
    );
    expect_err(
        &p,
        move_cmd(vec![mv("ghost", 0, &v1)]),
        ErrorCode::NotFound,
        None,
    );
    expect_err(
        &p,
        move_cmd(vec![mv(&a, 0, "ghost")]),
        ErrorCode::NotFound,
        None,
    );
    expect_err(
        &p,
        move_cmd(vec![mv(&a, 10, &v1), mv(&a, 20, &v1)]),
        ErrorCode::InvalidArgument,
        Some("moves"),
    );
    expect_err(
        &p,
        move_cmd(vec![mv(&a, 10, &a1)]),
        ErrorCode::InvalidArgument,
        Some("moves.track_id"),
    );
    expect_err(
        &p,
        move_cmd(vec![mv(&a, -10, &v1)]),
        ErrorCode::InvalidArgument,
        Some("moves.start"),
    );
    expect_err(
        &p,
        move_cmd(vec![mv(&a, 0, &v1)]),
        ErrorCode::Conflict,
        None,
    );
    // two moved clips landing on top of each other
    expect_err(
        &p,
        move_cmd(vec![mv(&a, 500, &v2), mv(&b, 550, &v2)]),
        ErrorCode::Conflict,
        None,
    );
    for mode_cmd in [move_cmd as fn(Vec<ClipMove>) -> Command, shuffle_cmd] {
        // locked source and locked target
        let locked = lock(&p, "V1");
        expect_err(
            &locked,
            mode_cmd(vec![mv(&a, 400, &v2)]),
            ErrorCode::TrackLocked,
            None,
        );
        let locked = lock(&p, "V2");
        expect_err(
            &locked,
            mode_cmd(vec![mv(&a, 400, &v2)]),
            ErrorCode::TrackLocked,
            None,
        );
    }
}

#[test]
fn shuffle_insert_reorders_clips_without_overwriting() {
    let (p, [a, b, c]) = abc();
    let v1 = track_id(&p, "V1");
    // C to the front
    let q = run(&p, shuffle_cmd(vec![mv(&c, 0, &v1)]));
    assert_eq!(order(&q, "V1"), vec![c.clone(), a.clone(), b.clone()]);
    assert_eq!(
        spans_src(&q, "V1"),
        vec![(0, 100, 200), (100, 200, 0), (200, 300, 100)]
    );
    // A dropped on the B|C cut: lands between them
    let q = run(&p, shuffle_cmd(vec![mv(&a, 200, &v1)]));
    assert_eq!(order(&q, "V1"), vec![b.clone(), a.clone(), c.clone()]);
    assert_eq!(spans(&q, "V1"), vec![(0, 100), (100, 200), (200, 300)]);
    // A dropped at the very end
    let q = run(&p, shuffle_cmd(vec![mv(&a, 300, &v1)]));
    assert_eq!(order(&q, "V1"), vec![b.clone(), c.clone(), a.clone()]);
    assert_eq!(spans(&q, "V1"), vec![(0, 100), (100, 200), (200, 300)]);
    // B to the front
    let q = run(&p, shuffle_cmd(vec![mv(&b, 0, &v1)]));
    assert_eq!(order(&q, "V1"), vec![b, a, c]);
    assert_eq!(q.duration(), fr(300));
}

#[test]
fn shuffle_insert_keeps_linked_tracks_in_sync() {
    // three linked A/V pairs back to back
    let (p, x) = add_range(&project(), "vid", Some(0), Some(0), Some(100));
    let (p, y) = add_range(&p, "vid", Some(100), Some(100), Some(200));
    let (p, z) = add_range(&p, "vid", Some(200), Some(200), Some(300));
    let (v1, a1) = (track_id(&p, "V1"), track_id(&p, "A1"));
    let q = run(&p, shuffle_cmd(vec![mv(&z[0], 0, &v1), mv(&z[1], 0, &a1)]));
    assert_eq!(
        order(&q, "V1"),
        vec![z[0].clone(), x[0].clone(), y[0].clone()]
    );
    assert_eq!(
        order(&q, "A1"),
        vec![z[1].clone(), x[1].clone(), y[1].clone()]
    );
    assert_eq!(spans_src(&q, "V1"), spans_src(&q, "A1"));
    for pair in [&x, &y, &z] {
        assert_eq!(
            q.clips[&pair[0]].sync_anchor(),
            q.clips[&pair[1]].sync_anchor()
        );
    }
}

#[test]
fn shuffle_insert_into_the_middle_of_a_clip_splits_it() {
    let (p, long) = add(&project(), "mute", Some(0)); // 0..600
    let (p, short) = add_range(&p, "mute", Some(600), Some(0), Some(50));
    let v1 = track_id(&p, "V1");
    let q = run(&p, shuffle_cmd(vec![mv(&short[0], 300, &v1)]));
    assert_eq!(
        spans_src(&q, "V1"),
        vec![(0, 300, 0), (300, 350, 0), (350, 650, 300)]
    );
    assert_eq!(on(&q, "V1")[0].id, long[0]);
    assert_eq!(q.duration(), fr(650));
}

// ---------------------------------------------------------------------------------
// TrimClips
// ---------------------------------------------------------------------------------

/// One silent clip on V1 at 100..400 showing source 150..450 of a 600-frame asset.
fn trim_base() -> (Project, ClipId) {
    let (p, ids) = add_range(&project(), "mute", Some(100), Some(150), Some(450));
    (p, ids[0].clone())
}

fn trim(id: &str, edge: Edge, delta_frames: i64, ripple: bool) -> Command {
    Command::TrimClips {
        clip_ids: vec![id.into()],
        edge,
        delta: fr(delta_frames),
        ripple,
    }
}

#[test]
fn trim_end_moves_the_out_point_within_the_media() {
    let (p, id) = trim_base();
    let q = run(&p, trim(&id, Edge::End, -50, false));
    assert_eq!(spans_src(&q, "V1"), vec![(100, 350, 150)]);
    assert_eq!(q.clips[&id].source_out(), src(400));
    let q = run(&p, trim(&id, Edge::End, 100, false));
    assert_eq!(spans_src(&q, "V1"), vec![(100, 500, 150)]);
    // cannot extend past the end of the source
    let q = run(&p, trim(&id, Edge::End, 10_000, false));
    assert_eq!(spans(&q, "V1"), vec![(100, 550)]);
    assert_eq!(q.clips[&id].source_out(), src(600));
    expect_err(
        &q,
        trim(&id, Edge::End, 1, false),
        ErrorCode::Conflict,
        None,
    );
    // cannot shrink below one frame
    let q = run(&p, trim(&id, Edge::End, -10_000, false));
    assert_eq!(spans(&q, "V1"), vec![(100, 101)]);
    expect_err(
        &q,
        trim(&id, Edge::End, -1, false),
        ErrorCode::Conflict,
        None,
    );
}

#[test]
fn trim_start_moves_the_in_point_and_source_in_together() {
    let (p, id) = trim_base();
    let q = run(&p, trim(&id, Edge::Start, 50, false));
    assert_eq!(spans_src(&q, "V1"), vec![(150, 400, 200)]);
    assert_eq!(
        q.clips[&id].source_out(),
        src(450),
        "the out point must not move"
    );
    let q = run(&p, trim(&id, Edge::Start, -60, false));
    assert_eq!(spans_src(&q, "V1"), vec![(40, 400, 90)]);
    // limited by the timeline start (100 frames) before the source start (150 frames)
    let q = run(&p, trim(&id, Edge::Start, -10_000, false));
    assert_eq!(spans_src(&q, "V1"), vec![(0, 400, 50)]);
    expect_err(
        &q,
        trim(&id, Edge::Start, -1, false),
        ErrorCode::Conflict,
        None,
    );
    // limited by the source start when there is room on the timeline
    let v1 = track_id(&p, "V1");
    let moved = run(
        &p,
        Command::MoveClips {
            moves: vec![mv(&id, 1000, &v1)],
            mode: PlaceMode::Overwrite,
        },
    );
    let q = run(&moved, trim(&id, Edge::Start, -10_000, false));
    assert_eq!(spans_src(&q, "V1"), vec![(850, 1300, 0)]);
    // one frame minimum
    let q = run(&p, trim(&id, Edge::Start, 10_000, false));
    assert_eq!(spans_src(&q, "V1"), vec![(399, 400, 449)]);
}

#[test]
fn trim_stops_at_neighbouring_clips() {
    let (p, id) = trim_base(); // 100..400
    let (p, _) = add_range(&p, "mute", Some(450), Some(0), Some(50));
    let (p, _) = add_range(&p, "mute", Some(0), Some(0), Some(80));
    let q = run(&p, trim(&id, Edge::End, 120, false));
    assert_eq!(spans(&q, "V1"), vec![(0, 80), (100, 450), (450, 500)]);
    let q = run(&p, trim(&id, Edge::Start, -90, false));
    assert_eq!(
        spans_src(&q, "V1"),
        vec![(0, 80, 0), (80, 400, 130), (450, 500, 0)]
    );
}

#[test]
fn trim_snaps_off_grid_deltas_and_respects_speed() {
    let (p, id) = trim_base();
    let q = run(
        &p,
        Command::TrimClips {
            clip_ids: vec![id.clone()],
            edge: Edge::End,
            delta: fr(10) + fr(1) / 3,
            ripple: false,
        },
    );
    assert_eq!(spans(&q, "V1"), vec![(100, 410)]);
    // at 2× the 450 remaining source frames last 225 output frames
    let fast = run(
        &p,
        Command::SetSpeed {
            clip_ids: vec![id.clone()],
            speed: 2.0,
            ripple: true,
        },
    );
    assert_eq!(spans(&fast, "V1"), vec![(100, 250)]);
    let q = run(&fast, trim(&id, Edge::End, 10_000, false));
    assert_eq!(spans(&q, "V1"), vec![(100, 325)]);
    assert_eq!(q.clips[&id].source_out(), src(600));
    // head trim at 2× consumes source twice as fast
    let q = run(&fast, trim(&id, Edge::Start, 20, false));
    assert_eq!(spans_src(&q, "V1"), vec![(120, 250, 190)]);
}

#[test]
fn stills_and_text_have_no_source_limit() {
    let (p, ids) = add(&project(), "img", Some(100));
    let q = run(&p, trim(&ids[0], Edge::End, 100_000, false));
    assert_eq!(spans(&q, "V1"), vec![(100, 100_250)]);
    let q = run(&p, trim(&ids[0], Edge::Start, -100_000, false));
    assert_eq!(spans_src(&q, "V1"), vec![(0, 250, 0)]);
}

#[test]
fn linked_clips_trim_by_one_uniform_amount() {
    let (p, pair) = add_range(&project(), "vid", Some(0), Some(0), Some(300));
    // something in the way on the audio track only
    let a1 = track_id(&p, "A1");
    let p = run(
        &p,
        Command::AddAssetClips {
            asset_id: "aud".into(),
            start: Some(tl(350)),
            track_id: Some(a1),
            source_in: None,
            source_out: Some(src(100)),
            mode: PlaceMode::Overwrite,
        },
    );
    let q = run(
        &p,
        Command::TrimClips {
            clip_ids: pair.clone(),
            edge: Edge::End,
            delta: fr(400),
            ripple: false,
        },
    );
    assert_eq!(
        q.clips[&pair[0]].end(),
        tl(350),
        "video is held back by the audio's neighbour"
    );
    assert_eq!(q.clips[&pair[1]].end(), tl(350));
    let q = run(
        &p,
        Command::TrimClips {
            clip_ids: pair.clone(),
            edge: Edge::Start,
            delta: fr(40),
            ripple: false,
        },
    );
    for id in &pair {
        assert_eq!(
            (q.clips[id].start, q.clips[id].source_in),
            (tl(40), src(40))
        );
    }
    assert_eq!(
        q.clips[&pair[0]].sync_anchor(),
        q.clips[&pair[1]].sync_anchor()
    );
}

#[test]
fn trim_validation() {
    let (p, id) = trim_base();
    expect_err(
        &p,
        Command::TrimClips {
            clip_ids: vec![],
            edge: Edge::End,
            delta: fr(1),
            ripple: false,
        },
        ErrorCode::InvalidArgument,
        Some("clip_ids"),
    );
    expect_err(
        &p,
        trim("ghost", Edge::End, 1, false),
        ErrorCode::NotFound,
        None,
    );
    expect_err(
        &p,
        trim(&id, Edge::End, 0, false),
        ErrorCode::Conflict,
        None,
    );
    let locked = lock(&p, "V1");
    expect_err(
        &locked,
        trim(&id, Edge::End, -10, false),
        ErrorCode::TrackLocked,
        None,
    );
    expect_err(
        &locked,
        trim(&id, Edge::End, -10, true),
        ErrorCode::TrackLocked,
        None,
    );
}

/// V1: A 0..100 (source 100..200), B 100..200. V2: title 150..250. A2: music 0..500.
fn ripple_base() -> (Project, ClipId, ClipId) {
    let (p, a) = add_range(&project(), "mute", Some(0), Some(100), Some(200));
    let (p, b) = add_range(&p, "mute", Some(100), Some(0), Some(100));
    let p = run(
        &p,
        Command::AddText {
            text: "Title".into(),
            start: tl(150),
            duration: Some(fr(100)),
            track_id: None,
        },
    );
    let a2 = track_id(&p, "A2");
    let p = run(
        &p,
        Command::AddAssetClips {
            asset_id: "aud".into(),
            start: Some(tl(0)),
            track_id: Some(a2),
            source_in: None,
            source_out: Some(src(500)),
            mode: PlaceMode::Overwrite,
        },
    );
    (p, a[0].clone(), b[0].clone())
}

#[test]
fn ripple_trim_end_pushes_or_pulls_everything_after_the_edit() {
    let (p, a, _b) = ripple_base();
    let q = run(&p, trim(&a, Edge::End, 50, true));
    assert_eq!(spans_src(&q, "V1"), vec![(0, 150, 100), (150, 250, 0)]);
    assert_eq!(
        spans(&q, "V2"),
        vec![(200, 300)],
        "later clips on other tracks follow"
    );
    assert_eq!(
        spans(&q, "A2"),
        vec![(0, 500)],
        "a clip spanning the edit stays put"
    );
    let q = run(&p, trim(&a, Edge::End, -40, true));
    assert_eq!(spans_src(&q, "V1"), vec![(0, 60, 100), (60, 160, 0)]);
    assert_eq!(spans(&q, "V2"), vec![(110, 210)]);
    assert_eq!(spans(&q, "A2"), vec![(0, 500)]);
    assert_eq!(q.clips[&a].source_out(), src(160));
}

#[test]
fn ripple_trim_start_changes_the_head_without_moving_the_clip() {
    let (p, a, _b) = ripple_base();
    let q = run(&p, trim(&a, Edge::Start, 30, true));
    assert_eq!(spans_src(&q, "V1"), vec![(0, 70, 130), (70, 170, 0)]);
    assert_eq!(spans(&q, "V2"), vec![(120, 220)]);
    assert_eq!(q.clips[&a].source_out(), src(200));
    // extend the head (allowed even though the clip sits at 0)
    let q = run(&p, trim(&a, Edge::Start, -30, true));
    assert_eq!(spans_src(&q, "V1"), vec![(0, 130, 70), (130, 230, 0)]);
    assert_eq!(spans(&q, "V2"), vec![(180, 280)]);
    // limited by the available source (100 frames of head)
    let q = run(&p, trim(&a, Edge::Start, -10_000, true));
    assert_eq!(spans_src(&q, "V1"), vec![(0, 200, 0), (200, 300, 0)]);
}

#[test]
fn ripple_trim_reports_when_other_tracks_block_the_close() {
    let (p, a, _b) = ripple_base();
    // a title straddling the edit point on V2, with another right after the old one
    let v2 = track_id(&p, "V2");
    let p = run(
        &p,
        Command::AddText {
            text: "Blocker".into(),
            start: tl(80),
            duration: Some(fr(60)),
            track_id: Some(v2),
        },
    );
    assert_eq!(spans(&p, "V2"), vec![(80, 140), (150, 250)]);
    let res = try_run(&p, trim(&a, Edge::End, -40, true)).unwrap();
    let q = res.project;
    // only 10 frames can close (150 - 140); every track moves by the same amount
    assert_eq!(spans(&q, "V1"), vec![(0, 60), (90, 190)]);
    assert_eq!(spans(&q, "V2"), vec![(80, 140), (140, 240)]);
    assert_eq!(res.notices.len(), 1);
}

#[test]
fn ripple_trim_needs_a_common_edit_point() {
    let (p, a, b) = ripple_base();
    expect_err(
        &p,
        Command::TrimClips {
            clip_ids: vec![a, b],
            edge: Edge::End,
            delta: fr(-10),
            ripple: true,
        },
        ErrorCode::Conflict,
        None,
    );
}

#[test]
fn ripple_trim_of_a_linked_pair_keeps_everything_in_sync() {
    let (p, x) = add_range(&project(), "vid", Some(0), Some(0), Some(100));
    let (p, y) = add_range(&p, "vid", Some(100), Some(300), Some(400));
    let q = run(
        &p,
        Command::TrimClips {
            clip_ids: x.clone(),
            edge: Edge::End,
            delta: fr(-25),
            ripple: true,
        },
    );
    assert_eq!(spans_src(&q, "V1"), vec![(0, 75, 0), (75, 175, 300)]);
    assert_eq!(spans_src(&q, "A1"), vec![(0, 75, 0), (75, 175, 300)]);
    assert_eq!(q.clips[&y[0]].sync_anchor(), q.clips[&y[1]].sync_anchor());
    assert_eq!(q.duration(), fr(175));
}

// ---------------------------------------------------------------------------------
// SlipClips
// ---------------------------------------------------------------------------------

#[test]
fn slip_shifts_the_source_window_without_moving_the_clip() {
    let (p, id) = trim_base(); // 100..400 showing 150..450 of 600
    let slip = |d: i64| Command::SlipClips {
        clip_ids: vec![id.clone()],
        delta: fr(d),
    };
    let q = run(&p, slip(100));
    assert_eq!(spans_src(&q, "V1"), vec![(100, 400, 250)]);
    let q = run(&p, slip(10_000));
    assert_eq!(spans_src(&q, "V1"), vec![(100, 400, 300)]);
    expect_err(&q, slip(1), ErrorCode::Conflict, None);
    let q = run(&p, slip(-10_000));
    assert_eq!(spans_src(&q, "V1"), vec![(100, 400, 0)]);
    expect_err(&q, slip(-1), ErrorCode::Conflict, None);
    // stills cannot be slipped
    let (pi, img) = add(&project(), "img", Some(0));
    expect_err(
        &pi,
        Command::SlipClips {
            clip_ids: img,
            delta: fr(5),
        },
        ErrorCode::Conflict,
        None,
    );
}

#[test]
fn slip_of_a_linked_pair_is_uniform() {
    let (p, pair) = add_range(&project(), "vid", Some(0), Some(100), Some(200));
    let q = run(
        &p,
        Command::SlipClips {
            clip_ids: pair.clone(),
            delta: fr(-500),
        },
    );
    for id in &pair {
        assert_eq!(q.clips[id].source_in, src(0));
    }
    assert_eq!(
        q.clips[&pair[0]].sync_anchor(),
        q.clips[&pair[1]].sync_anchor()
    );
}

// ---------------------------------------------------------------------------------
// SplitClips
// ---------------------------------------------------------------------------------

#[test]
fn split_at_playhead_cuts_every_track_and_relinks_the_right_halves() {
    let (p, pair) = add(&project(), "vid", Some(0));
    let a2 = track_id(&p, "A2");
    let p = run(
        &p,
        Command::AddAssetClips {
            asset_id: "aud".into(),
            start: Some(tl(300)),
            track_id: Some(a2),
            source_in: None,
            source_out: Some(src(600)),
            mode: PlaceMode::Overwrite,
        },
    );
    let res = try_run(
        &p,
        Command::SplitClips {
            at: tl(600),
            clip_ids: None,
        },
    )
    .unwrap();
    let q = res.project;
    assert_eq!(res.created.len(), 3);
    assert_eq!(spans_src(&q, "V1"), vec![(0, 600, 0), (600, 1800, 600)]);
    assert_eq!(spans_src(&q, "A1"), vec![(0, 600, 0), (600, 1800, 600)]);
    assert_eq!(spans_src(&q, "A2"), vec![(300, 600, 0), (600, 900, 300)]);
    let (v, a) = (on(&q, "V1"), on(&q, "A1"));
    assert_eq!(v[0].id, pair[0]);
    assert_eq!(a[0].id, pair[1]);
    assert_eq!(v[0].link_id, a[0].link_id);
    assert_eq!(v[1].link_id, a[1].link_id);
    assert!(v[1].link_id.is_some());
    assert_ne!(
        v[0].link_id, v[1].link_id,
        "left and right halves are separate link sets"
    );
    assert!(on(&q, "A2").iter().all(|c| c.link_id.is_none()));
    for id in &res.created {
        assert_eq!(q.clips[id].start, tl(600));
    }
}

#[test]
fn split_of_selected_clips_only() {
    let (p, pair) = add(&project(), "vid", Some(0));
    let q = run(
        &p,
        Command::SplitClips {
            at: tl(900),
            clip_ids: Some(vec![pair[0].clone()]),
        },
    );
    assert_eq!(spans(&q, "V1"), vec![(0, 900), (900, 1800)]);
    assert_eq!(spans(&q, "A1"), vec![(0, 1800)]);
    let v = on(&q, "V1");
    assert_eq!(
        v[0].link_id, q.clips[&pair[1]].link_id,
        "left half stays linked to the uncut audio"
    );
    assert!(v[1].link_id.is_none(), "a lone right half is unlinked");
}

#[test]
fn split_needs_a_clip_strictly_under_the_position() {
    let (p, pair) = add_range(&project(), "vid", Some(100), Some(0), Some(100));
    for at in [0, 100, 200, 500] {
        expect_err(
            &p,
            Command::SplitClips {
                at: tl(at),
                clip_ids: None,
            },
            ErrorCode::Conflict,
            None,
        );
        expect_err(
            &p,
            Command::SplitClips {
                at: tl(at),
                clip_ids: Some(pair.clone()),
            },
            ErrorCode::Conflict,
            None,
        );
    }
    expect_err(
        &p,
        Command::SplitClips {
            at: tl(-1),
            clip_ids: None,
        },
        ErrorCode::InvalidArgument,
        Some("at"),
    );
    expect_err(
        &p,
        Command::SplitClips {
            at: tl(150),
            clip_ids: Some(vec!["ghost".into()]),
        },
        ErrorCode::NotFound,
        None,
    );
    expect_err(
        &p,
        Command::SplitClips {
            at: tl(150),
            clip_ids: Some(vec![]),
        },
        ErrorCode::InvalidArgument,
        Some("clip_ids"),
    );
    // off-grid positions snap to the nearest frame
    let q = run(
        &p,
        Command::SplitClips {
            at: TimelineTime(fr(150) - 2),
            clip_ids: None,
        },
    );
    assert_eq!(spans(&q, "V1"), vec![(100, 150), (150, 200)]);
}

#[test]
fn split_skips_locked_tracks_unless_asked_explicitly() {
    let (p, pair) = add(&project(), "vid", Some(0));
    let locked = lock(&p, "A1");
    let q = run(
        &locked,
        Command::SplitClips {
            at: tl(600),
            clip_ids: None,
        },
    );
    assert_eq!(spans(&q, "V1"), vec![(0, 600), (600, 1800)]);
    assert_eq!(spans(&q, "A1"), vec![(0, 1800)]);
    expect_err(
        &locked,
        Command::SplitClips {
            at: tl(600),
            clip_ids: Some(pair),
        },
        ErrorCode::TrackLocked,
        None,
    );
}

#[test]
fn split_divides_fades_and_copies_properties_and_groups() {
    let (p, a) = add_range(&project(), "mute", Some(0), Some(0), Some(300));
    let (p, b) = add_range(&p, "mute", Some(300), Some(0), Some(100));
    let p = run(
        &p,
        Command::GroupClips {
            clip_ids: vec![a[0].clone(), b[0].clone()],
        },
    );
    let p = run_json(
        &p,
        json!({"type": "update_clips", "clip_ids": [a[0]], "patch": {"fade_in": fr(10), "fade_out": fr(20), "scale": 0.5, "rotation": 15.0, "saturation": 0.2, "opacity": 0.8}}),
    );
    let q = run(
        &p,
        Command::SplitClips {
            at: tl(120),
            clip_ids: Some(vec![a[0].clone()]),
        },
    );
    let v = on(&q, "V1");
    assert_eq!((v[0].fade_in, v[0].fade_out), (fr(10), 0));
    assert_eq!((v[1].fade_in, v[1].fade_out), (0, fr(20)));
    assert_eq!(v[1].transform, v[0].transform);
    assert_eq!(v[1].transform.scale, 0.5);
    assert_eq!(v[1].color, v[0].color);
    assert_eq!(v[1].group_id, v[0].group_id);
    assert!(v[1].group_id.is_some());
}

#[test]
fn split_keeps_a_transition_on_its_cut() {
    let (p, [a, b, _c]) = abc();
    let p = run(
        &p,
        Command::AddTransitions {
            left_clip_ids: vec![a.clone()],
            kind: TransitionKind::CrossDissolve,
            duration: fr(20),
        },
    );
    assert_eq!(p.transitions.len(), 1);
    // split the outgoing clip: the transition belongs to its right half now
    let q = run(
        &p,
        Command::SplitClips {
            at: tl(50),
            clip_ids: None,
        },
    );
    let v = on(&q, "V1");
    let t = q.transitions.values().next().expect("transition survives");
    assert_eq!(t.left, v[1].id);
    assert_eq!(t.right, b);
    assert_ne!(t.left, a);
    // split the incoming clip: its left half keeps the id, so nothing changes
    let q = run(
        &p,
        Command::SplitClips {
            at: tl(150),
            clip_ids: None,
        },
    );
    let t = q.transitions.values().next().expect("transition survives");
    assert_eq!((t.left.clone(), t.right.clone()), (a, b));
}

#[test]
fn split_text_and_stills() {
    let p = run(
        &project(),
        Command::AddText {
            text: "Hello".into(),
            start: tl(0),
            duration: Some(fr(100)),
            track_id: None,
        },
    );
    let (p, _) = add(&p, "img", Some(0));
    let q = run(
        &p,
        Command::SplitClips {
            at: tl(40),
            clip_ids: None,
        },
    );
    let t = on(&q, "V2");
    assert_eq!(spans(&q, "V2"), vec![(0, 40), (40, 100)]);
    assert_eq!(t[0].content, t[1].content);
    assert_eq!(
        spans_src(&q, "V1"),
        vec![(0, 40, 0), (40, 150, 0)],
        "stills have no source position"
    );
}
