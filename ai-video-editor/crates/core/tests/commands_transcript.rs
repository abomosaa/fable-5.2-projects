//! Transcript-driven editing commands: source-range ripple deletes with an audit
//! trail, healing, corrections, speakers, rough cuts and caption generation.

mod common;
use common::*;
use cutline_core::captions::CaptionOptions;
use cutline_core::commands::{Command, CueDraft, PlaceMode, SourceCut, SourceRange};
use cutline_core::error::ErrorCode;
use cutline_core::mapping::timeline_transcript;
use cutline_core::model::*;
use cutline_core::time::SourceTime;
use cutline_core::transcript::{Env, Transcript};
use serde_json::json;

const WORDS: [&str; 20] = [
    "w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8", "w9", "w10", "w11", "w12", "w13", "w14",
    "w15", "w16", "w17", "w18", "w19",
];

/// Word i spans source frames `[15 i, 15 i + 12)`.
fn vid_transcript() -> Transcript {
    transcript("vid", &even_words(&WORDS, 500, 400, "1"))
}

fn env() -> Env {
    env_with(vec![vid_transcript()])
}

/// `vid` (60 s) as a linked pair from frame 0: (project, video id, audio id).
fn base() -> (Project, ClipId, ClipId) {
    let (p, ids) = add(&project(), "vid", Some(0));
    (p, ids[0].clone(), ids[1].clone())
}

fn cut(clip: &ClipId, from: i64, to: i64, text: &str) -> SourceCut {
    SourceCut {
        clip_id: clip.clone(),
        source_start: src(from),
        source_end: src(to),
        text: text.into(),
    }
}

fn remove(cuts: Vec<SourceCut>, reason: RemovalReason) -> Command {
    Command::RippleDeleteSource { cuts, reason }
}

fn lock(p: &Project, track: &str) -> Project {
    let id = track_id(p, track);
    run_json(
        p,
        json!({"type": "update_track", "track_id": id, "locked": true}),
    )
}

// ---------------------------------------------------------------------------------
// RippleDeleteSource
// ---------------------------------------------------------------------------------

#[test]
fn removing_a_word_cuts_the_linked_pair_and_closes_the_gap() {
    let (p, v, a) = base();
    let original_link = p.clips[&a].link_id.clone();
    let res = try_run(
        &p,
        remove(vec![cut(&a, 60, 72, "w4")], RemovalReason::Manual),
    )
    .unwrap();
    let q = res.project;
    assert_eq!(res.label, "Remove transcript range");
    assert!(res.notices.is_empty());
    assert_eq!(spans_src(&q, "A1"), vec![(0, 60, 0), (60, 1788, 72)]);
    assert_eq!(
        spans_src(&q, "V1"),
        vec![(0, 60, 0), (60, 1788, 72)],
        "the linked picture is cut identically"
    );
    assert_eq!(q.duration(), p.duration() - fr(12));
    let (vs, as_) = (on(&q, "V1"), on(&q, "A1"));
    assert_eq!(
        (vs[0].id.clone(), as_[0].id.clone()),
        (v, a.clone()),
        "left parts keep their ids"
    );
    assert_eq!(vs[0].link_id, original_link);
    assert_eq!(as_[0].link_id, original_link);
    assert_eq!(vs[1].link_id, as_[1].link_id);
    assert!(vs[1].link_id.is_some());
    assert_ne!(
        vs[1].link_id, original_link,
        "each side of the cut is its own linked pair"
    );
    assert_eq!(vs[1].sync_anchor(), as_[1].sync_anchor());
    // audit trail
    assert_eq!(q.transcript.removals.len(), 1);
    let t = &q.transcript.removals[0];
    assert_eq!(
        (t.asset_id.as_str(), t.clip_id.as_str()),
        ("vid", a.as_str())
    );
    assert_eq!((t.source_start, t.source_end), (src(60), src(72)));
    assert_eq!((t.timeline_start, t.timeline_end), (tl(60), tl(72)));
    assert_eq!(
        (t.reason, t.text.as_str(), t.revision),
        (RemovalReason::Manual, "w4", q.revision)
    );
}

#[test]
fn touching_cuts_merge_into_one_edit_and_separate_cuts_stay_separate() {
    let (p, _v, a) = base();
    // w4 and w5 selected as one contiguous stretch (word start to next word start)
    let res = try_run(
        &p,
        remove(
            vec![cut(&a, 75, 90, "w5"), cut(&a, 60, 75, "w4")],
            RemovalReason::Manual,
        ),
    )
    .unwrap();
    let q = res.project;
    assert_eq!(spans_src(&q, "A1"), vec![(0, 60, 0), (60, 1770, 90)]);
    assert_eq!(q.transcript.removals.len(), 1, "one merged audit entry");
    assert_eq!(q.transcript.removals[0].text, "w4 w5");
    assert_eq!(
        (
            q.transcript.removals[0].source_start,
            q.transcript.removals[0].source_end
        ),
        (src(60), src(90))
    );
    assert_eq!(res.label, "Remove transcript range");
    // two fillers far apart: two cuts, three pieces, both tracks
    let res = try_run(
        &p,
        remove(
            vec![cut(&a, 60, 72, "um"), cut(&a, 150, 162, "uh")],
            RemovalReason::Filler,
        ),
    )
    .unwrap();
    let q = res.project;
    assert_eq!(
        spans_src(&q, "A1"),
        vec![(0, 60, 0), (60, 138, 72), (138, 1776, 162)]
    );
    assert_eq!(spans_src(&q, "V1"), spans_src(&q, "A1"));
    assert_eq!(res.label, "Remove 2 filler words");
    assert_eq!(q.transcript.removals.len(), 2);
    assert_eq!(q.duration(), p.duration() - fr(24));
    // every piece is a linked pair of its own
    let (vs, as_) = (on(&q, "V1"), on(&q, "A1"));
    let mut links = std::collections::BTreeSet::new();
    for i in 0..3 {
        assert_eq!(vs[i].link_id, as_[i].link_id);
        assert!(links.insert(vs[i].link_id.clone().unwrap()));
    }
}

#[test]
fn cuts_in_several_clips_and_any_order() {
    let (p, x) = add_range(&project(), "vid", Some(0), Some(0), Some(300));
    let (p, y) = add_range(&p, "vid", Some(300), Some(600), Some(900));
    let cuts = vec![
        cut(&x[1], 30, 60, "a"),
        cut(&y[1], 700, 760, "b"),
        cut(&x[1], 200, 210, "c"),
    ];
    let expected = vec![
        (0, 30, 0),
        (30, 170, 60),
        (170, 260, 210),
        (260, 360, 600),
        (360, 500, 760),
    ];
    let q = run(&p, remove(cuts.clone(), RemovalReason::Silence));
    assert_eq!(spans_src(&q, "A1"), expected);
    assert_eq!(spans_src(&q, "V1"), expected);
    let mut reversed = cuts;
    reversed.reverse();
    let q2 = run(&p, remove(reversed, RemovalReason::Silence));
    assert_eq!(
        spans_src(&q2, "A1"),
        expected,
        "the result does not depend on the order of the cuts"
    );
    assert_eq!(q.transcript.removals.len(), 3);
    assert!(q
        .transcript
        .removals
        .iter()
        .all(|r| r.reason == RemovalReason::Silence));
    assert_eq!(q.duration(), p.duration() - fr(100));
}

#[test]
fn the_same_range_given_through_both_linked_clips_is_removed_once() {
    let (p, v, a) = base();
    let q = run(
        &p,
        remove(
            vec![cut(&a, 60, 72, "w4"), cut(&v, 60, 72, "w4")],
            RemovalReason::Manual,
        ),
    );
    assert_eq!(spans_src(&q, "A1"), vec![(0, 60, 0), (60, 1788, 72)]);
    assert_eq!(spans_src(&q, "V1"), vec![(0, 60, 0), (60, 1788, 72)]);
    assert_eq!(q.duration(), p.duration() - fr(12));
}

#[test]
fn sub_frame_ranges_remove_the_frame_that_contains_them() {
    let (p, _v, a) = base();
    let tiny = SourceCut {
        clip_id: a.clone(),
        source_start: SourceTime(fr(60) + 10),
        source_end: SourceTime(fr(60) + 500),
        text: "tick".into(),
    };
    let q = run(&p, remove(vec![tiny], RemovalReason::Manual));
    assert_eq!(spans_src(&q, "A1"), vec![(0, 60, 0), (60, 1799, 61)]);
    // off-grid word boundaries round to the nearest frames
    let off = SourceCut {
        clip_id: a.clone(),
        source_start: SourceTime(fr(60) + fr(1) / 3),
        source_end: SourceTime(fr(72) - fr(1) / 3),
        text: String::new(),
    };
    let q = run(&p, remove(vec![off], RemovalReason::Manual));
    assert_eq!(spans_src(&q, "A1"), vec![(0, 60, 0), (60, 1788, 72)]);
}

#[test]
fn cuts_follow_speed_changes() {
    let (p, v, a) = base();
    let p = run(
        &p,
        Command::SetSpeed {
            clip_ids: vec![v, a.clone()],
            speed: 2.0,
            ripple: true,
        },
    );
    assert_eq!(spans(&p, "A1"), vec![(0, 900)]);
    let q = run(
        &p,
        remove(vec![cut(&a, 60, 72, "w4")], RemovalReason::Manual),
    );
    // source 60..72 plays at timeline 30..36
    assert_eq!(spans_src(&q, "A1"), vec![(0, 30, 0), (30, 894, 72)]);
    assert_eq!(spans_src(&q, "V1"), vec![(0, 30, 0), (30, 894, 72)]);
    let t = &q.transcript.removals[0];
    assert_eq!((t.timeline_start, t.timeline_end), (tl(30), tl(36)));
    assert_eq!((t.source_start, t.source_end), (src(60), src(72)));
    // the transcript view agrees: w4 is gone, w5 follows directly
    let view = timeline_transcript(&q, &env().transcripts);
    assert_eq!(view.segments[1].words[0].index, 5);
    assert_eq!(view.segments[1].removed_before.as_ref().unwrap().text, "w4");
}

#[test]
fn cuts_are_clamped_to_the_clip_and_may_remove_it_entirely() {
    let (p, x) = add_range(&project(), "vid", Some(0), Some(100), Some(200));
    let (p, y) = add_range(&p, "vid", Some(100), Some(500), Some(600));
    // reaches before the clip's in point: only the part inside is removed
    let q = run(
        &p,
        remove(vec![cut(&x[1], 50, 120, "")], RemovalReason::Manual),
    );
    assert_eq!(spans_src(&q, "A1"), vec![(0, 80, 120), (80, 180, 500)]);
    assert_eq!(
        (
            q.transcript.removals[0].source_start,
            q.transcript.removals[0].source_end
        ),
        (src(100), src(120))
    );
    // covers the whole clip: both linked clips disappear
    let q = run(
        &p,
        remove(vec![cut(&x[1], 0, 1000, "")], RemovalReason::Manual),
    );
    assert_eq!(spans_src(&q, "A1"), vec![(0, 100, 500)]);
    assert_eq!(spans_src(&q, "V1"), vec![(0, 100, 500)]);
    assert!(!q.clips.contains_key(&x[0]) && !q.clips.contains_key(&x[1]));
    assert_eq!(q.clips[&y[0]].link_id, q.clips[&y[1]].link_id);
}

#[test]
fn captions_and_other_tracks_follow_a_transcript_cut() {
    let (p, _v, a) = base();
    let cues = vec![
        CueDraft {
            start: tl(30),
            duration: fr(20),
            text: "before".into(),
            speaker: None,
            source: None,
        },
        CueDraft {
            start: tl(62),
            duration: fr(8),
            text: "inside".into(),
            speaker: None,
            source: None,
        },
        CueDraft {
            start: tl(100),
            duration: fr(30),
            text: "after".into(),
            speaker: None,
            source: None,
        },
    ];
    let p = run(
        &p,
        Command::AddCaptions {
            cues,
            track_id: None,
        },
    );
    let p = run(
        &p,
        Command::AddText {
            text: "Lower third".into(),
            start: tl(200),
            duration: Some(fr(50)),
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
            source_out: Some(src(400)),
            mode: PlaceMode::Overwrite,
        },
    );
    let p = run(
        &p,
        Command::AddMarker {
            time: tl(300),
            label: "beat".into(),
            color: None,
        },
    );
    let q = run(
        &p,
        remove(vec![cut(&a, 60, 72, "w4")], RemovalReason::Manual),
    );
    assert_eq!(spans(&q, "C1"), vec![(30, 50), (88, 118)]);
    assert_eq!(
        spans(&q, "V2"),
        vec![(188, 238)],
        "titles after the cut stay over the same picture"
    );
    assert_eq!(
        spans(&q, "A2"),
        vec![(0, 400)],
        "music spanning the cut is not chopped"
    );
    assert_eq!(q.markers[0].time, tl(288));
}

#[test]
fn a_blocked_close_is_reported_but_the_range_is_still_removed() {
    let (p, _v, a) = base();
    // a title that starts inside the removed range and another right behind it leave no room
    let p = run(
        &p,
        Command::AddText {
            text: "A".into(),
            start: tl(66),
            duration: Some(fr(34)),
            track_id: None,
        },
    ); // 66..100
    let v2 = track_id(&p, "V2");
    let p = run(
        &p,
        Command::AddText {
            text: "B".into(),
            start: tl(100),
            duration: Some(fr(20)),
            track_id: Some(v2),
        },
    ); // 100..120
    let res = try_run(
        &p,
        remove(vec![cut(&a, 60, 72, "w4")], RemovalReason::Manual),
    )
    .unwrap();
    assert_eq!(res.notices.len(), 1);
    assert_eq!(
        spans_src(&res.project, "A1"),
        vec![(0, 60, 0), (72, 1800, 72)]
    );
    assert_eq!(spans(&res.project, "V2"), vec![(66, 100), (100, 120)]);
    assert_eq!(res.project.transcript.removals.len(), 1);
}

#[test]
fn unlinked_and_locked_companions_are_left_alone() {
    let (p, v, a) = base();
    let unlinked = run(
        &p,
        Command::UnlinkClips {
            clip_ids: vec![v.clone(), a.clone()],
        },
    );
    let q = run(
        &unlinked,
        remove(vec![cut(&a, 60, 72, "w4")], RemovalReason::Manual),
    );
    assert_eq!(spans(&q, "A1"), vec![(0, 60), (60, 1788)]);
    assert_eq!(spans(&q, "V1"), vec![(0, 1800)]);
    // linked but the video track is locked: only the audio is cut
    let locked = lock(&p, "V1");
    let q = run(
        &locked,
        remove(vec![cut(&a, 60, 72, "w4")], RemovalReason::Manual),
    );
    assert_eq!(spans(&q, "A1"), vec![(0, 60), (60, 1788)]);
    assert_eq!(spans(&q, "V1"), vec![(0, 1800)]);
    // cutting through a clip on a locked track is refused
    let locked_audio = lock(&p, "A1");
    expect_err(
        &locked_audio,
        remove(vec![cut(&a, 60, 72, "w4")], RemovalReason::Manual),
        ErrorCode::TrackLocked,
        None,
    );
}

#[test]
fn source_cut_validation() {
    let (p, _v, a) = base();
    expect_err(
        &p,
        remove(vec![], RemovalReason::Manual),
        ErrorCode::InvalidArgument,
        Some("cuts"),
    );
    expect_err(
        &p,
        remove(
            vec![cut(&"ghost".to_string(), 0, 10, "")],
            RemovalReason::Manual,
        ),
        ErrorCode::NotFound,
        None,
    );
    expect_err(
        &p,
        remove(vec![cut(&a, 72, 60, "")], RemovalReason::Manual),
        ErrorCode::InvalidArgument,
        Some("cuts"),
    );
    expect_err(
        &p,
        remove(vec![cut(&a, 60, 60, "")], RemovalReason::Manual),
        ErrorCode::InvalidArgument,
        Some("cuts"),
    );
    // not a media clip
    let with_text = run(
        &p,
        Command::AddText {
            text: "T".into(),
            start: tl(0),
            duration: None,
            track_id: None,
        },
    );
    let text_id = on(&with_text, "V2")[0].id.clone();
    expect_err(
        &with_text,
        remove(vec![cut(&text_id, 0, 10, "")], RemovalReason::Manual),
        ErrorCode::InvalidArgument,
        Some("cuts.clip_id"),
    );
    // stale: the words were trimmed off the clip since the transcript was shown
    let trimmed = run(
        &p,
        Command::TrimClips {
            clip_ids: vec![a.clone()],
            edge: cutline_core::commands::Edge::Start,
            delta: fr(100),
            ripple: false,
        },
    );
    expect_err(
        &trimmed,
        remove(vec![cut(&a, 60, 72, "w4")], RemovalReason::Manual),
        ErrorCode::Conflict,
        None,
    );
    // one stale cut rejects the whole edit, including the valid cuts
    expect_err(
        &trimmed,
        remove(
            vec![cut(&a, 150, 162, "ok"), cut(&a, 60, 72, "stale")],
            RemovalReason::Manual,
        ),
        ErrorCode::Conflict,
        None,
    );
}

#[test]
fn many_filler_removals_in_one_command() {
    let (p, _v, a) = base();
    // remove every third word (7 cuts) at once
    let cuts: Vec<SourceCut> = (0..20)
        .step_by(3)
        .map(|i| cut(&a, 15 * i, 15 * i + 12, WORDS[i as usize]))
        .collect();
    let n = cuts.len() as i64;
    let res = try_run(&p, remove(cuts, RemovalReason::Filler)).unwrap();
    let q = res.project;
    assert_eq!(q.duration(), p.duration() - fr(12 * n));
    assert_eq!(q.transcript.removals.len(), n as usize);
    assert_eq!(spans_src(&q, "A1"), spans_src(&q, "V1"));
    let view = timeline_transcript(&q, &env().transcripts);
    let kept: Vec<u32> = view
        .segments
        .iter()
        .flat_map(|s| s.words.iter().map(|w| w.index))
        .collect();
    assert_eq!(kept, (0..20).filter(|i| i % 3 != 0).collect::<Vec<u32>>());
    assert_eq!(
        view.removed_count,
        n as u32 - 1,
        "w0 was at the very start: nothing before it to hang the marker on"
    );
    // gapless: every piece touches the next
    let a1 = on(&q, "A1");
    assert_eq!(a1[0].start, tl(0));
    assert!(a1.windows(2).all(|w| w[0].end() == w[1].start));
}

// ---------------------------------------------------------------------------------
// HealCuts
// ---------------------------------------------------------------------------------

#[test]
fn healing_a_cut_restores_the_document_exactly() {
    let (p, v, a) = base();
    let q = run(
        &p,
        remove(vec![cut(&a, 60, 72, "w4")], RemovalReason::Manual),
    );
    let res = try_run(
        &q,
        Command::HealCuts {
            left_clip_ids: vec![a.clone(), v.clone()],
        },
    )
    .unwrap();
    assert_eq!(res.label, "Restore removed media");
    let healed = res.project;
    assert!(
        same_doc(&healed, &p),
        "healing must give back the pre-cut document (ids, links, trace and all)"
    );
    assert!(healed.transcript.removals.is_empty());
}

#[test]
fn healing_one_of_several_cuts_only_touches_that_cut() {
    let (p, _v, a) = base();
    let q = run(
        &p,
        remove(
            vec![cut(&a, 60, 72, "um"), cut(&a, 150, 162, "uh")],
            RemovalReason::Filler,
        ),
    );
    // pieces: [0,60) [60,138) [138,…); heal the second cut (between piece 2 and 3)
    let (vs, as_) = (on(&q, "V1"), on(&q, "A1"));
    let healed = run(
        &q,
        Command::HealCuts {
            left_clip_ids: vec![as_[1].id.clone(), vs[1].id.clone()],
        },
    );
    assert_eq!(spans_src(&healed, "A1"), vec![(0, 60, 0), (60, 1788, 72)]);
    assert_eq!(spans_src(&healed, "V1"), vec![(0, 60, 0), (60, 1788, 72)]);
    assert_eq!(healed.transcript.removals.len(), 1);
    assert_eq!(healed.transcript.removals[0].text, "um");
    // then the first: everything is back
    let (vs, as_) = (on(&healed, "V1"), on(&healed, "A1"));
    let all = run(
        &healed,
        Command::HealCuts {
            left_clip_ids: vec![as_[0].id.clone(), vs[0].id.clone()],
        },
    );
    assert_eq!(spans_src(&all, "A1"), vec![(0, 1800, 0)]);
    assert!(all.transcript.removals.is_empty());
    assert_eq!(on(&all, "A1")[0].link_id, on(&all, "V1")[0].link_id);
}

#[test]
fn healing_pushes_later_material_on_every_track() {
    let (p, v, a) = base();
    let p = run(
        &p,
        Command::AddText {
            text: "Later".into(),
            start: tl(500),
            duration: Some(fr(50)),
            track_id: None,
        },
    );
    let p = run(
        &p,
        Command::AddCaptions {
            cues: vec![CueDraft {
                start: tl(400),
                duration: fr(30),
                text: "cap".into(),
                speaker: None,
                source: None,
            }],
            track_id: None,
        },
    );
    let q = run(
        &p,
        remove(vec![cut(&a, 60, 90, "w4 w5")], RemovalReason::Manual),
    );
    assert_eq!(spans(&q, "V2"), vec![(470, 520)]);
    assert_eq!(spans(&q, "C1"), vec![(370, 400)]);
    let healed = run(
        &q,
        Command::HealCuts {
            left_clip_ids: vec![a, v],
        },
    );
    assert_eq!(spans(&healed, "V2"), vec![(500, 550)]);
    assert_eq!(spans(&healed, "C1"), vec![(400, 430)]);
    assert!(same_doc(&healed, &p));
}

#[test]
fn healing_works_at_other_speeds_and_after_manual_cuts() {
    let (p, v, a) = base();
    let fast = run(
        &p,
        Command::SetSpeed {
            clip_ids: vec![v.clone(), a.clone()],
            speed: 2.0,
            ripple: true,
        },
    );
    let q = run(
        &fast,
        remove(vec![cut(&a, 60, 72, "w4")], RemovalReason::Manual),
    );
    let healed = run(
        &q,
        Command::HealCuts {
            left_clip_ids: vec![a.clone(), v.clone()],
        },
    );
    assert!(same_doc(&healed, &fast));
    // a hand-made jump cut (no audit entry) heals the same way
    let q = run(
        &p,
        Command::SplitClips {
            at: tl(60),
            clip_ids: None,
        },
    );
    let q = run(
        &q,
        Command::SplitClips {
            at: tl(90),
            clip_ids: None,
        },
    );
    let middle: Vec<ClipId> = q
        .clips
        .values()
        .filter(|c| c.start == tl(60))
        .map(|c| c.id.clone())
        .collect();
    let q = run(
        &q,
        Command::DeleteClips {
            clip_ids: middle,
            ripple: true,
        },
    );
    let healed = run(
        &q,
        Command::HealCuts {
            left_clip_ids: vec![a.clone(), v.clone()],
        },
    );
    assert_eq!(spans_src(&healed, "A1"), vec![(0, 1800, 0)]);
    assert_eq!(spans_src(&healed, "V1"), vec![(0, 1800, 0)]);
    assert_eq!(healed.clips[&a].link_id, healed.clips[&v].link_id);
    assert!(healed.clips[&a].link_id.is_some());
}

#[test]
fn heal_rejections() {
    let (p, v, a) = base();
    // nothing after the clip
    expect_err(
        &p,
        Command::HealCuts {
            left_clip_ids: vec![a.clone()],
        },
        ErrorCode::Conflict,
        None,
    );
    expect_err(
        &p,
        Command::HealCuts {
            left_clip_ids: vec![],
        },
        ErrorCode::InvalidArgument,
        Some("clip_ids"),
    );
    expect_err(
        &p,
        Command::HealCuts {
            left_clip_ids: vec!["ghost".into()],
        },
        ErrorCode::NotFound,
        None,
    );
    // a plain split has nothing removed
    let split = run(
        &p,
        Command::SplitClips {
            at: tl(60),
            clip_ids: None,
        },
    );
    expect_err(
        &split,
        Command::HealCuts {
            left_clip_ids: vec![a.clone()],
        },
        ErrorCode::Conflict,
        None,
    );
    // the clip after the cut was moved away
    let q = run(
        &p,
        remove(vec![cut(&a, 60, 72, "w4")], RemovalReason::Manual),
    );
    let right_a = on(&q, "A1")[1].id.clone();
    let right_v = on(&q, "V1")[1].id.clone();
    let (v1, a1) = (track_id(&q, "V1"), track_id(&q, "A1"));
    let moved = run(
        &q,
        Command::MoveClips {
            moves: vec![
                cutline_core::commands::ClipMove {
                    clip_id: right_v,
                    start: tl(100),
                    track_id: v1,
                },
                cutline_core::commands::ClipMove {
                    clip_id: right_a,
                    start: tl(100),
                    track_id: a1,
                },
            ],
            mode: PlaceMode::Overwrite,
        },
    );
    let e = expect_err(
        &moved,
        Command::HealCuts {
            left_clip_ids: vec![a.clone(), v.clone()],
        },
        ErrorCode::Conflict,
        None,
    );
    assert!(
        e.message.to_lowercase().contains("undo"),
        "the message should point to undo: {}",
        e.message
    );
    // cuts that do not line up cannot be healed together
    let two = run(
        &p,
        remove(
            vec![cut(&a, 60, 72, "a"), cut(&a, 150, 180, "b")],
            RemovalReason::Manual,
        ),
    );
    let as_ = on(&two, "A1");
    expect_err(
        &two,
        Command::HealCuts {
            left_clip_ids: vec![as_[0].id.clone(), as_[1].id.clone()],
        },
        ErrorCode::Conflict,
        None,
    );
    expect_err(
        &lock(&q, "A1"),
        Command::HealCuts {
            left_clip_ids: vec![a],
        },
        ErrorCode::TrackLocked,
        None,
    );
}

// ---------------------------------------------------------------------------------
// Corrections, speakers, mode switch
// ---------------------------------------------------------------------------------

#[test]
fn correct_word_applies_reverts_and_validates() {
    let (p, _v, _a) = base();
    let env = env();
    let fix = |i: u32, t: Option<&str>| Command::CorrectWord {
        asset_id: "vid".into(),
        word_index: i,
        text: t.map(str::to_string),
    };
    let res = try_run_env(&p, fix(3, Some("three")), &env).unwrap();
    assert_eq!(res.label, "Correct transcript");
    let q = res.project;
    assert_eq!(q.transcript.corrections["vid"][&3], "three");
    // overwrite, then revert with None / empty / the original text
    let q2 = run_env(&q, fix(3, Some("THREE")), &env);
    assert_eq!(q2.transcript.corrections["vid"][&3], "THREE");
    for revert in [None, Some(""), Some("   "), Some("w3")] {
        let res = try_run_env(&q2, fix(3, revert), &env).unwrap();
        assert!(
            res.project.transcript.corrections.is_empty(),
            "revert via {revert:?}"
        );
        assert_eq!(res.label, "Revert transcript correction");
    }
    // reverting something that was never corrected is a conflict, not a silent no-op
    expect_err_env(&p, fix(3, None), &env, ErrorCode::Conflict, None);
    expect_err_env(&p, fix(3, Some("w3")), &env, ErrorCode::Conflict, None);
    // validation
    expect_err_env(
        &p,
        fix(20, Some("x")),
        &env,
        ErrorCode::InvalidArgument,
        Some("word_index"),
    );
    expect_err_env(
        &p,
        fix(3, Some(&"x".repeat(121))),
        &env,
        ErrorCode::InvalidArgument,
        Some("text"),
    );
    expect_err_env(
        &p,
        fix(3, Some("two\nlines")),
        &env,
        ErrorCode::InvalidArgument,
        Some("text"),
    );
    expect_err_env(
        &p,
        Command::CorrectWord {
            asset_id: "ghost".into(),
            word_index: 0,
            text: Some("x".into()),
        },
        &env,
        ErrorCode::NotFound,
        None,
    );
    expect_err_env(
        &p,
        Command::CorrectWord {
            asset_id: "vid2".into(),
            word_index: 0,
            text: Some("x".into()),
        },
        &env,
        ErrorCode::Conflict,
        None,
    );
    expect_err(&p, fix(3, Some("x")), ErrorCode::Conflict, None); // no transcript loaded at all
                                                                  // the provider data is never modified
    assert_eq!(*env.transcripts["vid"], vid_transcript());
}

#[test]
fn rename_speaker_sets_trims_and_clears() {
    let (p, _v, _a) = base();
    let rename = |s: &str, n: Option<&str>| Command::RenameSpeaker {
        asset_id: "vid".into(),
        speaker: s.into(),
        name: n.map(str::to_string),
    };
    let q = run(&p, rename("1", Some("  Ann Lee ")));
    assert_eq!(q.transcript.speaker_names["vid"]["1"], "Ann Lee");
    let q = run(&q, rename("2", Some("Bob")));
    assert_eq!(q.transcript.speaker_names["vid"].len(), 2);
    let q = run(&q, rename("1", None));
    assert_eq!(q.transcript.speaker_names["vid"].len(), 1);
    let q = run(&q, rename("2", Some("  ")));
    assert!(
        q.transcript.speaker_names.is_empty(),
        "empty maps are pruned"
    );
    expect_err(
        &p,
        rename("", Some("x")),
        ErrorCode::InvalidArgument,
        Some("speaker"),
    );
    expect_err(
        &p,
        rename("1", Some(&"n".repeat(61))),
        ErrorCode::InvalidArgument,
        Some("name"),
    );
    expect_err(
        &p,
        Command::RenameSpeaker {
            asset_id: "ghost".into(),
            speaker: "1".into(),
            name: Some("x".into()),
        },
        ErrorCode::NotFound,
        None,
    );
}

#[test]
fn transcript_editing_switch() {
    let p = project();
    assert!(!p.transcript.enabled);
    let res = try_run(&p, Command::SetTranscriptEditing { enabled: true }).unwrap();
    assert!(res.project.transcript.enabled);
    assert_eq!(res.label, "Enable transcript editing");
    let off = run(
        &res.project,
        Command::SetTranscriptEditing { enabled: false },
    );
    assert!(!off.transcript.enabled);
}

// ---------------------------------------------------------------------------------
// Rough cuts
// ---------------------------------------------------------------------------------

fn range(a: i64, b: i64) -> SourceRange {
    SourceRange {
        start: src(a),
        end: src(b),
    }
}

#[test]
fn rough_cut_appends_passages_in_the_given_order_as_linked_pairs() {
    let p = project();
    let res = try_run(
        &p,
        Command::AppendSourceRanges {
            asset_id: "vid".into(),
            ranges: vec![range(300, 450), range(0, 90), range(900, 1000)],
            at: None,
        },
    )
    .unwrap();
    let q = res.project;
    assert_eq!(res.label, "Rough cut: add 3 passages");
    assert_eq!(res.created.len(), 6);
    let expected = vec![(0, 150, 300), (150, 240, 0), (240, 340, 900)];
    assert_eq!(spans_src(&q, "V1"), expected);
    assert_eq!(spans_src(&q, "A1"), expected);
    let (vs, as_) = (on(&q, "V1"), on(&q, "A1"));
    let mut links = std::collections::BTreeSet::new();
    for i in 0..3 {
        assert_eq!(vs[i].link_id, as_[i].link_id);
        assert!(
            links.insert(vs[i].link_id.clone().unwrap()),
            "each passage is its own pair"
        );
    }
    // appending again continues after the existing material
    let q2 = run(
        &q,
        Command::AppendSourceRanges {
            asset_id: "vid".into(),
            ranges: vec![range(10, 20)],
            at: None,
        },
    );
    assert_eq!(spans_src(&q2, "V1").last().copied(), Some((340, 350, 10)));
    // the transcript of the rough cut reads in the new order
    let view = timeline_transcript(&q, &env().transcripts);
    let order: Vec<u32> = view
        .segments
        .iter()
        .flat_map(|s| s.words.iter().map(|w| w.index))
        .collect();
    assert_eq!(
        order,
        vec![0, 1, 2, 3, 4, 5],
        "only the 0..90 passage has words in this transcript"
    );
    // 300..450 → 0..90 jumps backwards in the media: a rearrangement, not a removal
    assert!(view.segments[1].removed_before.is_none());
    // 0..90 → 900..1000 skips forward: everything in between reads as left out
    let skipped = view.segments[2]
        .removed_before
        .as_ref()
        .expect("skipped media is shown at the cut");
    assert_eq!(
        (
            skipped.source_start,
            skipped.source_end,
            skipped.word_count,
            skipped.reason
        ),
        (src(90), src(900), 14, None)
    );
}

#[test]
fn rough_cut_can_ripple_insert_at_a_position() {
    let (p, _) = add_range(&project(), "vid2", Some(0), Some(0), Some(300));
    let q = run(
        &p,
        Command::AppendSourceRanges {
            asset_id: "vid".into(),
            ranges: vec![range(600, 660), range(60, 100)],
            at: Some(tl(150)),
        },
    );
    let expected = vec![
        (0, 150, 0),
        (150, 210, 600),
        (210, 250, 60),
        (250, 400, 150),
    ];
    assert_eq!(spans_src(&q, "V1"), expected);
    assert_eq!(spans_src(&q, "A1"), expected);
    assert_eq!(q.duration(), fr(400));
    // audio-only assets work too
    let q = run(
        &p,
        Command::AppendSourceRanges {
            asset_id: "aud".into(),
            ranges: vec![range(0, 50)],
            at: None,
        },
    );
    assert_eq!(spans(&q, "A1"), vec![(0, 300), (300, 350)]);
    assert_eq!(spans(&q, "V1"), vec![(0, 300)]);
}

#[test]
fn rough_cut_validation() {
    let p = project();
    let rc = |asset: &str, ranges: Vec<SourceRange>| Command::AppendSourceRanges {
        asset_id: asset.into(),
        ranges,
        at: None,
    };
    expect_err(
        &p,
        rc("vid", vec![]),
        ErrorCode::InvalidArgument,
        Some("ranges"),
    );
    expect_err(
        &p,
        rc("ghost", vec![range(0, 10)]),
        ErrorCode::NotFound,
        None,
    );
    expect_err(
        &p,
        rc("img", vec![range(0, 10)]),
        ErrorCode::InvalidArgument,
        Some("asset_id"),
    );
    expect_err(
        &p,
        rc("sub", vec![range(0, 10)]),
        ErrorCode::InvalidArgument,
        Some("asset_id"),
    );
    expect_err(
        &p,
        rc("vid", vec![range(10, 10)]),
        ErrorCode::InvalidArgument,
        Some("ranges"),
    );
    expect_err(
        &p,
        rc("vid", vec![range(-5, 10)]),
        ErrorCode::InvalidArgument,
        Some("ranges"),
    );
    expect_err(
        &p,
        rc("vid", vec![range(0, 10), range(1700, 1900)]),
        ErrorCode::InvalidArgument,
        Some("ranges"),
    );
    expect_err(
        &p,
        rc("vid", vec![range(0, 1); 2001]),
        ErrorCode::InvalidArgument,
        Some("ranges"),
    );
    expect_err(
        &p,
        Command::AppendSourceRanges {
            asset_id: "vid".into(),
            ranges: vec![range(0, 10)],
            at: Some(tl(-1)),
        },
        ErrorCode::InvalidArgument,
        Some("at"),
    );
}

// ---------------------------------------------------------------------------------
// GenerateCaptions (command level)
// ---------------------------------------------------------------------------------

fn generated_flags(p: &Project) -> Vec<(String, bool)> {
    on(p, "C1")
        .iter()
        .map(|c| match &c.content {
            ClipContent::Caption {
                text, generated, ..
            } => (text.clone(), *generated),
            other => panic!("unexpected {other:?}"),
        })
        .collect()
}

#[test]
fn generate_captions_needs_transcribed_speech() {
    let (p, _v, _a) = base();
    let e = expect_err(
        &p,
        Command::GenerateCaptions {
            options: CaptionOptions::default(),
        },
        ErrorCode::Conflict,
        None,
    );
    assert!(e.message.to_lowercase().contains("transcri"));
    assert_eq!(
        p.tracks.len(),
        4,
        "no caption track is left behind by the failed command"
    );
    // empty timeline with transcripts available
    expect_err_env(
        &project(),
        Command::GenerateCaptions {
            options: CaptionOptions::default(),
        },
        &env(),
        ErrorCode::Conflict,
        None,
    );
    let bad = CaptionOptions {
        max_chars_per_line: 3,
        ..Default::default()
    };
    expect_err_env(
        &p,
        Command::GenerateCaptions { options: bad },
        &env(),
        ErrorCode::InvalidArgument,
        Some("options.max_chars_per_line"),
    );
}

#[test]
fn generated_captions_carry_provenance_and_are_replaced_on_regeneration() {
    let (p, _v, _a) = base();
    let env = env();
    let res = try_run_env(
        &p,
        Command::GenerateCaptions {
            options: CaptionOptions::default(),
        },
        &env,
    )
    .unwrap();
    let q = res.project;
    assert_eq!(q.tracks[0].kind, TrackKind::Caption);
    let caps = on(&q, "C1");
    assert!(!caps.is_empty());
    assert_eq!(res.label, format!("Generate {} captions", caps.len()));
    assert_eq!(res.created.len(), caps.len());
    let mut covered = Vec::new();
    for c in &caps {
        match &c.content {
            ClipContent::Caption {
                generated,
                source,
                text,
                ..
            } => {
                assert!(*generated);
                let s = source
                    .as_ref()
                    .expect("generated captions know their source words");
                assert_eq!(s.asset_id, "vid");
                assert!(s.word_end > s.word_start);
                let expected: Vec<&str> =
                    WORDS[s.word_start as usize..s.word_end as usize].to_vec();
                assert_eq!(text.split_whitespace().collect::<Vec<_>>(), expected);
                covered.extend(s.word_start..s.word_end);
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    assert_eq!(
        covered,
        (0..20).collect::<Vec<u32>>(),
        "every word is captioned exactly once"
    );
    // regenerating with other options replaces them wholesale
    let narrow = CaptionOptions {
        max_chars_per_line: 8,
        max_lines: 1,
        ..Default::default()
    };
    let q2 = run_env(&q, Command::GenerateCaptions { options: narrow }, &env);
    let caps2 = on(&q2, "C1");
    assert!(caps2.len() > caps.len());
    assert!(
        caps.iter().all(|c| !q2.clips.contains_key(&c.id)),
        "old generated captions are gone"
    );
    assert_eq!(
        q2.tracks
            .iter()
            .filter(|t| t.kind == TrackKind::Caption)
            .count(),
        1
    );
}

#[test]
fn regeneration_keeps_captions_the_user_wrote_or_edited() {
    let (p, _v, _a) = base();
    let env = env();
    let q = run_env(
        &p,
        Command::GenerateCaptions {
            options: CaptionOptions::default(),
        },
        &env,
    );
    let caps = on(&q, "C1");
    let edited = caps[1].clone();
    // edit one generated caption and add one by hand after the speech
    let q = run_json(
        &q,
        json!({"type": "update_clips", "clip_ids": [edited.id], "patch": {"text": "My own wording"}}),
    );
    let q = run(
        &q,
        Command::AddCaptions {
            cues: vec![CueDraft {
                start: tl(900),
                duration: fr(60),
                text: "[music]".into(),
                speaker: None,
                source: None,
            }],
            track_id: None,
        },
    );
    assert!(generated_flags(&q).contains(&("My own wording".to_string(), false)));
    let q2 = run_env(
        &q,
        Command::GenerateCaptions {
            options: CaptionOptions::default(),
        },
        &env,
    );
    let flags = generated_flags(&q2);
    assert!(
        flags.contains(&("My own wording".to_string(), false)),
        "the edited caption survives: {flags:?}"
    );
    assert!(flags.contains(&("[music]".to_string(), false)));
    let survivor = &q2.clips[&edited.id];
    assert_eq!(
        (survivor.start, survivor.duration),
        (edited.start, edited.duration)
    );
    assert_eq!(
        flags.iter().filter(|f| f.1).count(),
        caps.len() - 1,
        "everything else was regenerated around it"
    );
    // nothing left to regenerate when every caption is hand-made
    let all_ids: Vec<ClipId> = ids(&on(&q2, "C1"));
    let mut manual = q2.clone();
    for id in all_ids {
        let text = format!("edited {id}");
        manual = run_json(
            &manual,
            json!({"type": "update_clips", "clip_ids": [id], "patch": {"text": text}}),
        );
    }
    expect_err_env(
        &manual,
        Command::GenerateCaptions {
            options: CaptionOptions::default(),
        },
        &env,
        ErrorCode::Conflict,
        None,
    );
}

#[test]
fn captions_follow_the_edit_they_were_generated_from() {
    let (p, _v, a) = base();
    let env = env();
    // remove w4..w5 first: captions must skip those words and use the shifted times
    let q = run(
        &p,
        remove(vec![cut(&a, 60, 90, "w4 w5")], RemovalReason::Manual),
    );
    let q = run_env(
        &q,
        Command::GenerateCaptions {
            options: CaptionOptions::default(),
        },
        &env,
    );
    let text: Vec<String> = generated_flags(&q)
        .into_iter()
        .flat_map(|(t, _)| t.split_whitespace().map(str::to_string).collect::<Vec<_>>())
        .collect();
    assert!(!text.contains(&"w4".to_string()) && !text.contains(&"w5".to_string()));
    assert_eq!(text.len(), 18);
    // no caption straddles the cut at frame 60
    for c in on(&q, "C1") {
        assert!(
            c.end() <= tl(60) || c.start >= tl(60),
            "caption {:?} crosses the cut",
            (c.start, c.end())
        );
    }
    let last = on(&q, "C1").last().unwrap().clone();
    assert_eq!(last.end(), tl(15 * 19 + 12 - 30));
}
