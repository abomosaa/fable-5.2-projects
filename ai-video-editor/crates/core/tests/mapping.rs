//! Transcript ⇄ timeline mapping: trims, splits, speed, gaps, overlapping tracks,
//! audibility, corrections and removed ranges.

mod common;
use common::*;
use cutline_core::commands::{ClipMove, Command, PlaceMode, SourceCut};
use cutline_core::mapping::*;
use cutline_core::model::*;
use cutline_core::time::TimelineTime;
use cutline_core::transcript::{Env, Transcript};
use serde_json::json;

const WORDS: [&str; 20] = [
    "w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8", "w9", "w10", "w11", "w12", "w13", "w14",
    "w15", "w16", "w17", "w18", "w19",
];

/// 20 words for `vid`: word i spans source frames `[15 i, 15 i + 12)` (500 ms apart,
/// 400 ms long), so its midpoint is at frame `15 i + 6`.
fn vid_transcript() -> Transcript {
    transcript("vid", &even_words(&WORDS, 500, 400, "1"))
}

fn env() -> Env {
    env_with(vec![vid_transcript()])
}

fn view(p: &Project, env: &Env) -> TranscriptView {
    timeline_transcript(p, &env.transcripts)
}

fn indices(seg: &Segment) -> Vec<u32> {
    seg.words.iter().map(|w| w.index).collect()
}

/// `vid` on V1/A1 from frame 0; returns (project, video id, audio id).
fn base() -> (Project, ClipId, ClipId) {
    let (p, ids) = add(&project(), "vid", Some(0));
    (p, ids[0].clone(), ids[1].clone())
}

#[test]
fn words_of_an_untrimmed_clip_map_one_to_one() {
    let (p, _v, a) = base();
    let v = view(&p, &env());
    assert_eq!(v.revision, p.revision);
    assert_eq!(
        v.segments.len(),
        1,
        "one segment per audible audio clip (the video clip carries no words)"
    );
    let seg = &v.segments[0];
    assert_eq!(
        (seg.clip_id.as_str(), seg.asset_id.as_str()),
        (a.as_str(), "vid")
    );
    assert_eq!(seg.track_id, track_id(&p, "A1"));
    assert_eq!(
        (seg.start, seg.end, seg.source_start, seg.source_end),
        (tl(0), tl(1800), src(0), src(1800))
    );
    assert!(seg.fixture);
    assert!(seg.removed_before.is_none());
    assert_eq!(indices(seg), (0..20).collect::<Vec<_>>());
    for (i, w) in seg.words.iter().enumerate() {
        let i = i as i64;
        assert_eq!((w.start, w.end), (tl(15 * i), tl(15 * i + 12)));
        assert_eq!(
            (w.source_start, w.source_end),
            (src(15 * i), src(15 * i + 12))
        );
        assert_eq!(w.text, WORDS[i as usize]);
        assert!(w.original.is_none() && !w.filler);
        assert_eq!(w.speaker.as_deref(), Some("1"));
        assert_eq!(w.language.as_deref(), Some("en"));
        assert_eq!(w.confidence, Some(0.9));
    }
    assert_eq!(
        (
            v.word_count,
            v.filler_count,
            v.corrected_count,
            v.removed_count
        ),
        (20, 0, 0, 0)
    );
    assert!(v.untranscribed_assets.is_empty());
}

#[test]
fn trimmed_clips_only_show_the_words_they_contain() {
    // source frames 34..150: w2 (30..42, midpoint 36) is in, cut at its head; w10 (midpoint 156) is out
    let p = run(
        &project(),
        Command::AddAssetClips {
            asset_id: "vid".into(),
            start: Some(tl(100)),
            track_id: None,
            source_in: Some(src(34)),
            source_out: Some(src(150)),
            mode: PlaceMode::Overwrite,
        },
    );
    let v = view(&p, &env());
    let seg = &v.segments[0];
    assert_eq!(indices(seg), (2..=9).collect::<Vec<_>>());
    // the first word starts before the clip: clamped to the clip start
    assert_eq!((seg.words[0].start, seg.words[0].end), (tl(100), tl(108)));
    // its source timing is reported unclamped (it is the word's real position in the media)
    assert_eq!(
        (seg.words[0].source_start, seg.words[0].source_end),
        (src(30), src(42))
    );
    assert_eq!(
        (seg.words[1].start, seg.words[1].end),
        (tl(100 + 45 - 34), tl(100 + 57 - 34))
    );
    assert_eq!(seg.words.last().unwrap().end, tl(100 + 147 - 34));
    for w in &seg.words {
        assert!(w.start >= seg.start && w.end <= seg.end && w.start <= w.end);
    }
}

#[test]
fn a_cut_through_a_word_gives_it_to_exactly_one_side() {
    let (p, _v, _a) = base();
    // w4 spans frames 60..72 with its midpoint at 66
    for (at, owner_is_left) in [
        (61, false),
        (65, false),
        (66, false),
        (67, true),
        (71, true),
        (72, true),
        (60, false),
    ] {
        let q = run(
            &p,
            Command::SplitClips {
                at: tl(at),
                clip_ids: None,
            },
        );
        let v = view(&q, &env());
        assert_eq!(v.segments.len(), 2, "split at {at}");
        let (left, right) = (&v.segments[0], &v.segments[1]);
        let all: Vec<u32> = indices(left).into_iter().chain(indices(right)).collect();
        assert_eq!(
            all,
            (0..20).collect::<Vec<_>>(),
            "split at {at}: no word lost or duplicated"
        );
        assert_eq!(indices(left).contains(&4), owner_is_left, "split at {at}");
        // the owner shows the word clamped to its own extent
        let w4 = left
            .words
            .iter()
            .chain(&right.words)
            .find(|w| w.index == 4)
            .unwrap();
        if owner_is_left {
            assert_eq!((w4.start, w4.end), (tl(60), tl(at.min(72))));
        } else {
            assert_eq!((w4.start, w4.end), (tl(at.max(60)), tl(72)));
        }
        assert!(
            left.removed_before.is_none() && right.removed_before.is_none(),
            "a plain split removes nothing"
        );
        assert_eq!(v.word_count, 20);
    }
}

#[test]
fn many_cuts_never_lose_or_duplicate_words() {
    let (mut p, _v, _a) = base();
    let mut rng = Rng(2024);
    for _ in 0..40 {
        let at = rng.range(1, 330);
        if let Ok(a) = try_run(
            &p,
            Command::SplitClips {
                at: tl(at),
                clip_ids: None,
            },
        ) {
            p = a.project;
        }
    }
    let v = view(&p, &env());
    assert!(v.segments.len() > 20);
    let all: Vec<u32> = v.segments.iter().flat_map(indices).collect();
    assert_eq!(all, (0..20).collect::<Vec<_>>());
    // words stay in timeline order across segments
    let starts: Vec<TimelineTime> = v
        .segments
        .iter()
        .flat_map(|s| s.words.iter().map(|w| w.start))
        .collect();
    assert!(starts.windows(2).all(|w| w[0] <= w[1]));
}

#[test]
fn speed_changes_scale_word_times() {
    let (p, v, a) = base();
    let fast = run(
        &p,
        Command::SetSpeed {
            clip_ids: vec![v.clone(), a.clone()],
            speed: 2.0,
            ripple: true,
        },
    );
    let view_fast = view(&fast, &env());
    let seg = &view_fast.segments[0];
    assert_eq!(indices(seg), (0..20).collect::<Vec<_>>());
    for (i, w) in seg.words.iter().enumerate() {
        let i = i as i64;
        assert_eq!(w.start, TimelineTime(fr(15 * i) / 2), "word {i} at 2×");
        assert_eq!(w.end, TimelineTime(fr(15 * i + 12) / 2));
        assert_eq!(
            w.source_start,
            src(15 * i),
            "source timing is unaffected by speed"
        );
    }
    let slow = run(
        &p,
        Command::SetSpeed {
            clip_ids: vec![v, a],
            speed: 0.5,
            ripple: true,
        },
    );
    let view_slow = view(&slow, &env());
    for (i, w) in view_slow.segments[0].words.iter().enumerate() {
        let i = i as i64;
        assert_eq!((w.start, w.end), (tl(30 * i), tl(30 * i + 24)));
    }
    assert_eq!(
        view_slow.segments[0].speed,
        cutline_core::Speed::new(1, 2).unwrap()
    );
}

#[test]
fn speed_and_trim_and_position_compose() {
    // source 60..180 (w4..w11) at 1.5× placed at frame 300
    let (p, ids) = add_range(&project(), "vid", Some(300), Some(60), Some(180));
    let p = run(
        &p,
        Command::SetSpeed {
            clip_ids: ids.clone(),
            speed: 1.5,
            ripple: true,
        },
    );
    let v = view(&p, &env());
    let seg = &v.segments[0];
    assert_eq!(indices(seg), (4..=11).collect::<Vec<_>>());
    for w in &seg.words {
        let i = w.index as i64;
        // timeline = clip.start + (source - source_in) / 1.5
        assert_eq!(
            w.start,
            TimelineTime(fr(300) + (fr(15 * i) - fr(60)) * 2 / 3)
        );
        assert_eq!(
            w.end,
            TimelineTime(fr(300) + (fr(15 * i + 12) - fr(60)) * 2 / 3)
        );
    }
    assert_eq!(seg.end, tl(380));
}

#[test]
fn gaps_and_moves_shift_words_with_their_clip() {
    let (p, x) = add_range(&project(), "vid", Some(0), Some(0), Some(60));
    let (p, y) = add_range(&p, "vid", Some(500), Some(150), Some(240));
    let v = view(&p, &env());
    assert_eq!(v.segments.len(), 2);
    assert_eq!(indices(&v.segments[0]), vec![0, 1, 2, 3]);
    assert_eq!(indices(&v.segments[1]), vec![10, 11, 12, 13, 14, 15]);
    assert_eq!(v.segments[1].words[0].start, tl(500));
    assert!(
        v.segments[1].removed_before.is_none(),
        "clips separated by a gap are not a removal"
    );
    // move the second pair before the first: order in the transcript follows the timeline
    let (v1, a1) = (track_id(&p, "V1"), track_id(&p, "A1"));
    let moved = run(
        &p,
        Command::MoveClips {
            moves: vec![
                ClipMove {
                    clip_id: x[0].clone(),
                    start: tl(1000),
                    track_id: v1,
                },
                ClipMove {
                    clip_id: x[1].clone(),
                    start: tl(1000),
                    track_id: a1,
                },
            ],
            mode: PlaceMode::Overwrite,
        },
    );
    let v = view(&moved, &env());
    assert_eq!(v.segments[0].clip_id, y[1]);
    assert_eq!(v.segments[1].clip_id, x[1]);
    assert_eq!(v.segments[1].words[0].start, tl(1000));
    assert!(v.segments[1].removed_before.is_none());
}

#[test]
fn overlapping_clips_on_two_audio_tracks_both_appear_in_timeline_order() {
    let (p, _v, a) = base();
    let a2 = track_id(&p, "A2");
    let p = run(
        &p,
        Command::AddAssetClips {
            asset_id: "aud".into(),
            start: Some(tl(7)),
            track_id: Some(a2.clone()),
            source_in: None,
            source_out: Some(src(300)),
            mode: PlaceMode::Overwrite,
        },
    );
    let other = transcript("aud", &[("alpha", 0, 300, "9"), ("beta", 1000, 1400, "9")]);
    let env = env_with(vec![vid_transcript(), other]);
    let v = view(&p, &env);
    assert_eq!(v.segments.len(), 2);
    assert_eq!(v.segments[0].clip_id, a);
    assert_eq!(v.segments[1].track_id, a2);
    assert_eq!(
        v.segments[1]
            .words
            .iter()
            .map(|w| w.text.as_str())
            .collect::<Vec<_>>(),
        vec!["alpha", "beta"]
    );
    assert_eq!(v.segments[1].words[0].start, tl(7));
    assert_eq!(v.segments[1].words[1].start, tl(37));
    assert_eq!(v.word_count, 22);
    // equal starts: the upper track comes first
    let v1 = run(
        &p,
        Command::MoveClips {
            moves: vec![ClipMove {
                clip_id: v.segments[1].clip_id.clone(),
                start: tl(0),
                track_id: a2,
            }],
            mode: PlaceMode::Overwrite,
        },
    );
    let vv = view(&v1, &env);
    assert_eq!(vv.segments[0].track_id, track_id(&p, "A1"));
}

#[test]
fn only_audible_audio_contributes() {
    let (p, vclip, a) = base();
    let (a1, a2, v1) = (track_id(&p, "A1"), track_id(&p, "A2"), track_id(&p, "V1"));
    let env = env();
    assert!(clip_audible(&p, &p.clips[&a]));
    assert!(
        !clip_audible(&p, &p.clips[&vclip]),
        "video clips carry no sound"
    );
    // muted track
    let q = run_json(
        &p,
        json!({"type": "update_track", "track_id": a1, "muted": true}),
    );
    assert!(view(&q, &env).segments.is_empty());
    assert!(!clip_audible(&q, &q.clips[&a]));
    // another track soloed
    let q = run_json(
        &p,
        json!({"type": "update_track", "track_id": a2, "solo": true}),
    );
    assert!(view(&q, &env).segments.is_empty());
    // its own track soloed
    let q = run_json(
        &p,
        json!({"type": "update_track", "track_id": a1, "solo": true}),
    );
    assert_eq!(view(&q, &env).segments.len(), 1);
    // disabled clip
    let q = run_json(
        &p,
        json!({"type": "update_clips", "clip_ids": [a], "patch": {"enabled": false}}),
    );
    assert!(view(&q, &env).segments.is_empty());
    // hiding the picture does not silence the sound
    let q = run_json(
        &p,
        json!({"type": "update_track", "track_id": v1, "hidden": true}),
    );
    assert_eq!(view(&q, &env).segments.len(), 1);
    // deleting the audio half leaves nothing to read
    let q = run(
        &p,
        Command::DeleteClips {
            clip_ids: vec![a.clone()],
            ripple: false,
        },
    );
    let v = view(&q, &env);
    assert!(v.segments.is_empty() && v.untranscribed_assets.is_empty());
}

#[test]
fn audible_assets_without_a_transcript_are_reported_once() {
    let (p, _v, _a) = base();
    let (p, _) = add_range(&p, "vid2", None, Some(0), Some(100));
    let (p, _) = add_range(&p, "vid2", None, Some(200), Some(300));
    let (p, _) = add(&p, "mute", None);
    let v = view(&p, &env());
    assert_eq!(v.segments.len(), 1);
    assert_eq!(v.untranscribed_assets, vec!["vid2".to_string()]);
    let none = view(&p, &Env::default());
    assert!(none.segments.is_empty());
    assert_eq!(
        none.untranscribed_assets,
        vec!["vid".to_string(), "vid2".to_string()]
    );
}

#[test]
fn corrections_are_an_overlay_that_never_touches_the_source_transcript() {
    let (p, _v, _a) = base();
    let env = env();
    let pristine = vid_transcript();
    let q = run_env(
        &p,
        Command::CorrectWord {
            asset_id: "vid".into(),
            word_index: 3,
            text: Some("three".into()),
        },
        &env,
    );
    let q = run_env(
        &q,
        Command::CorrectWord {
            asset_id: "vid".into(),
            word_index: 7,
            text: Some("  seven ".into()),
        },
        &env,
    );
    let v = view(&q, &env);
    let w3 = &v.segments[0].words[3];
    assert_eq!(
        (w3.text.as_str(), w3.original.as_deref()),
        ("three", Some("w3"))
    );
    assert_eq!(
        (w3.start, w3.end, w3.source_start),
        (tl(45), tl(57), src(45)),
        "timing is untouched by a correction"
    );
    assert_eq!(v.segments[0].words[7].text, "seven");
    assert!(v.segments[0].words[4].original.is_none());
    assert_eq!(v.corrected_count, 2);
    assert_eq!(
        *env.transcripts["vid"], pristine,
        "provider tokens and words are immutable"
    );
    assert_eq!(env.transcripts["vid"].tokens[3].text, " w3");
    // a "correction" identical to the original is not flagged
    let mut same = q.clone();
    same.transcript
        .corrections
        .get_mut("vid")
        .unwrap()
        .insert(5, "w5".into());
    let v = view(&same, &env);
    assert!(v.segments[0].words[5].original.is_none());
    assert_eq!(v.corrected_count, 2);
    // corrections follow the word through cuts
    let cut = run(
        &q,
        Command::SplitClips {
            at: tl(55),
            clip_ids: None,
        },
    );
    let v = view(&cut, &env);
    assert_eq!(v.segments[0].words.last().unwrap().text, "three");
}

#[test]
fn removed_ranges_are_reported_at_the_cut_with_words_reason_and_heal_ids() {
    let (p, vclip, a) = base();
    let env = env();
    // remove w4 and w5 (source frames 60..90) through the audio clip
    let cut = SourceCut {
        clip_id: a.clone(),
        source_start: src(60),
        source_end: src(90),
        text: "w4 w5".into(),
    };
    let q = run(
        &p,
        Command::RippleDeleteSource {
            cuts: vec![cut],
            reason: RemovalReason::Filler,
        },
    );
    let v = view(&q, &env);
    assert_eq!(v.segments.len(), 2);
    assert_eq!(indices(&v.segments[0]), vec![0, 1, 2, 3]);
    assert_eq!(indices(&v.segments[1]), (6..20).collect::<Vec<_>>());
    assert_eq!(
        v.segments[1].words[0].start,
        tl(60),
        "later words moved up by the removed 30 frames"
    );
    assert!(v.segments[0].removed_before.is_none());
    let gap = v.segments[1]
        .removed_before
        .as_ref()
        .expect("the cut is visible in the transcript");
    assert_eq!((gap.source_start, gap.source_end), (src(60), src(90)));
    assert_eq!((gap.text.as_str(), gap.word_count), ("w4 w5", 2));
    assert_eq!(gap.reason, Some(RemovalReason::Filler));
    assert_eq!(
        gap.heal_clip_ids,
        vec![a.clone(), vclip.clone()],
        "audio clip first, then its linked video companion"
    );
    assert_eq!((v.word_count, v.removed_count), (18, 2));
    // the heal ids really do restore it
    let healed = run(
        &q,
        Command::HealCuts {
            left_clip_ids: gap.heal_clip_ids.clone(),
        },
    );
    let v = view(&healed, &env);
    assert_eq!(v.segments.len(), 1);
    assert_eq!(v.word_count, 20);
    assert_eq!(v.removed_count, 0);
}

#[test]
fn manual_cuts_show_up_as_removed_ranges_without_a_reason() {
    let (p, _v, _a) = base();
    let env = env();
    // razor at 60 and 90, ripple-delete the middle by hand
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
    let v = view(&q, &env);
    let gap = v.segments[1].removed_before.as_ref().unwrap();
    assert_eq!((gap.text.as_str(), gap.reason), ("w4 w5", None));
    assert_eq!(gap.heal_clip_ids.len(), 2);
    // a lift delete leaves a hole instead: nothing is "removed before" the next clip
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
            ripple: false,
        },
    );
    let v = view(&q, &env);
    assert!(v.segments.iter().all(|s| s.removed_before.is_none()));
    assert_eq!(v.removed_count, 0);
}

#[test]
fn unlinked_audio_only_offers_itself_for_healing() {
    let (p, vclip, a) = base();
    let p = run(
        &p,
        Command::UnlinkClips {
            clip_ids: vec![vclip, a.clone()],
        },
    );
    let cut = SourceCut {
        clip_id: a.clone(),
        source_start: src(60),
        source_end: src(90),
        text: String::new(),
    };
    let q = run(
        &p,
        Command::RippleDeleteSource {
            cuts: vec![cut],
            reason: RemovalReason::Manual,
        },
    );
    let v = view(&q, &env());
    assert_eq!(
        v.segments[1].removed_before.as_ref().unwrap().heal_clip_ids,
        vec![a]
    );
    assert_eq!(
        spans(&q, "V1"),
        vec![(0, 1800)],
        "the unlinked picture is not cut"
    );
}

#[test]
fn healable_requires_a_forward_jump_in_the_same_media() {
    let (p, x) = add_range(&project(), "vid", Some(0), Some(0), Some(100));
    let (p, y) = add_range(&p, "vid", Some(100), Some(200), Some(300));
    let (p, z) = add_range(&p, "vid2", Some(200), Some(400), Some(500));
    let (p, w) = add_range(&p, "vid", Some(300), Some(0), Some(50));
    let c = |id: &ClipId| p.clips[id].clone();
    assert!(healable(&c(&x[0]), &c(&y[0])));
    assert!(healable(&c(&x[1]), &c(&y[1])));
    assert!(!healable(&c(&x[0]), &c(&y[1])), "different tracks / kinds");
    assert!(!healable(&c(&y[0]), &c(&z[0])), "different assets");
    assert!(!healable(&c(&y[0]), &c(&x[0])), "wrong order");
    assert!(!healable(&c(&z[0]), &c(&w[0])), "different assets");
    // a backwards jump (the right clip shows earlier media) is a rearrangement, not a removal
    let (q, k) = add_range(&project(), "vid", Some(0), Some(300), Some(400));
    let (q, l) = add_range(&q, "vid", Some(100), Some(0), Some(100));
    assert!(!healable(&q.clips[&k[0]], &q.clips[&l[0]]));
    // a contiguous split is not healable either
    let s = run(
        &q,
        Command::SplitClips {
            at: tl(50),
            clip_ids: None,
        },
    );
    let v1 = on(&s, "V1");
    assert!(!healable(&v1[0], &v1[1]));
    // different speeds
    let fast = run(
        &p,
        Command::SetSpeed {
            clip_ids: y.clone(),
            speed: 2.0,
            ripple: true,
        },
    );
    assert!(!healable(&fast.clips[&x[0]], &fast.clips[&y[0]]));
}

#[test]
fn source_instants_map_to_every_clip_that_shows_them() {
    let (p, x) = add_range(&project(), "vid", Some(0), Some(0), Some(300));
    let (p, y) = add_range(&p, "vid", Some(500), Some(200), Some(400));
    let hits = source_to_timeline(&p, "vid", src(250));
    // shown by both pairs: video + audio of each, ordered by timeline time
    assert_eq!(hits.len(), 4);
    assert!(hits[..2]
        .iter()
        .all(|(id, t)| x.contains(id) && *t == tl(250)));
    assert!(hits[2..]
        .iter()
        .all(|(id, t)| y.contains(id) && *t == tl(550)));
    assert_eq!(source_to_timeline(&p, "vid", src(100)).len(), 2);
    assert!(source_to_timeline(&p, "vid", src(450)).is_empty());
    assert!(
        source_to_timeline(&p, "vid", src(400)).is_empty(),
        "the out point is exclusive"
    );
    assert_eq!(source_to_timeline(&p, "vid", src(200)).len(), 4);
    assert!(source_to_timeline(&p, "vid2", src(100)).is_empty());
    // with speed
    let fast = run(
        &p,
        Command::SetSpeed {
            clip_ids: y.clone(),
            speed: 2.0,
            ripple: true,
        },
    );
    let hits = source_to_timeline(&fast, "vid", src(300));
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].1, tl(550));
}

#[test]
fn speaker_names_and_fillers() {
    let (p, _v, _a) = base();
    assert_eq!(speaker_name(&p, "vid", "1"), "Speaker 1");
    let q = run(
        &p,
        Command::RenameSpeaker {
            asset_id: "vid".into(),
            speaker: "1".into(),
            name: Some("Ann".into()),
        },
    );
    assert_eq!(speaker_name(&q, "vid", "1"), "Ann");
    assert_eq!(speaker_name(&q, "vid", "2"), "Speaker 2");
    assert_eq!(
        speaker_name(&q, "vid2", "1"),
        "Speaker 1",
        "names are per asset"
    );
    let t = transcript(
        "vid",
        &[
            ("So,", 0, 200, "1"),
            ("um,", 300, 500, "1"),
            ("yes.", 600, 900, "1"),
            ("Uh", 1000, 1200, "2"),
        ],
    );
    let v = view(&p, &env_with(vec![t]));
    let fillers: Vec<bool> = v.segments[0].words.iter().map(|w| w.filler).collect();
    assert_eq!(fillers, vec![false, true, false, true]);
    assert_eq!(v.filler_count, 2);
    // serialised view omits empty optionals but always carries timing
    let json = serde_json::to_value(&v).unwrap();
    let w0 = &json["segments"][0]["words"][0];
    assert!(w0.get("original").is_none() && w0.get("filler").is_none());
    assert_eq!(json["segments"][0]["words"][1]["filler"], true);
    assert!(w0["start"].is_i64() && w0["source_start"].is_i64());
}

#[test]
fn word_range_uses_midpoints() {
    let t = vid_transcript();
    assert_eq!(t.word_range(src(0), src(1800)), (0, 20));
    assert_eq!(
        t.word_range(src(6), src(21)),
        (0, 1),
        "midpoint 6 is inside [6, 21)"
    );
    assert_eq!(
        t.word_range(src(7), src(21)),
        (1, 1),
        "midpoint 6 is outside [7, 21): empty"
    );
    assert_eq!(t.word_range(src(7), src(22)), (1, 2));
    assert_eq!(t.word_range(src(500), src(900)), (20, 20));
    assert_eq!(
        t.word_range(src(100), src(50)),
        (7, 7),
        "inverted ranges are empty, never panic"
    );
    assert_eq!(t.words[4].midpoint(), src(66));
}
