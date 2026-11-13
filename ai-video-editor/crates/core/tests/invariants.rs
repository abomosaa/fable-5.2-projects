//! Model-based stress test: long deterministic pseudo-random editing sessions.
//!
//! After every committed command the document must satisfy all invariants, the
//! change payload must reproduce the document, and a rejected command must never be
//! an internal invariant violation. At the end, undoing everything must give back
//! the starting document and redoing everything the final one.

mod common;
use common::*;
use cutline_core::commands::{ClipMove, Command, CueDraft, Edge, PlaceMode, SourceCut};
use cutline_core::error::ErrorCode;
use cutline_core::history::{History, Session, HISTORY_MAX_ENTRIES};
use cutline_core::model::*;
use cutline_core::resolve::resolve_layers;
use cutline_core::time::{FrameRate, SourceTime, TimelineTime};
use cutline_core::transcript::Env;
use cutline_core::validate;
use serde_json::json;

fn clip_ids(p: &Project) -> Vec<ClipId> {
    p.clips.keys().cloned().collect()
}

fn pick_clip(rng: &mut Rng, p: &Project) -> Option<ClipId> {
    let ids = clip_ids(p);
    if ids.is_empty() {
        None
    } else {
        Some(rng.pick(&ids).clone())
    }
}

/// The clip plus everything linked / grouped with it (what the UI would select).
fn with_companions(p: &Project, id: &ClipId) -> Vec<ClipId> {
    let c = &p.clips[id];
    p.clips
        .values()
        .filter(|o| {
            o.id == *id
                || (c.link_id.is_some() && o.link_id == c.link_id)
                || (c.group_id.is_some() && o.group_id == c.group_id)
        })
        .map(|o| o.id.clone())
        .collect()
}

fn some_clips(rng: &mut Rng, p: &Project) -> Vec<ClipId> {
    let Some(id) = pick_clip(rng, p) else {
        return vec![];
    };
    if rng.chance(60) {
        with_companions(p, &id)
    } else if rng.chance(30) {
        let mut v = vec![id];
        if let Some(other) = pick_clip(rng, p) {
            v.push(other);
        }
        v
    } else {
        vec![id]
    }
}

fn frame_time(p: &Project, rng: &mut Rng, max_frames: i64) -> TimelineTime {
    TimelineTime(p.fps().frame_to_ticks(rng.range(0, max_frames)))
}

fn frames_of(p: &Project, n: i64) -> i64 {
    p.fps().frame_to_ticks(n)
}

fn random_command(rng: &mut Rng, p: &Project) -> Command {
    let total = p.fps().ticks_to_frame_floor(p.duration()).max(60);
    let tracks: Vec<&Track> = p.tracks.iter().collect();
    match rng.range(0, 31) {
        0..=3 => {
            let asset = *rng.pick(&["vid", "vid2", "mute", "aud", "img"]);
            let dur = p.assets[asset].duration;
            let (source_in, source_out) = if dur > 0 && rng.chance(70) {
                let a = rng.range(0, dur - frames_of(p, 2));
                let b = (a + rng.range(frames_of(p, 1), frames_of(p, 200))).min(dur);
                (Some(SourceTime(a)), Some(SourceTime(b)))
            } else if dur == 0 && rng.chance(50) {
                (
                    Some(SourceTime(0)),
                    Some(SourceTime(rng.range(frames_of(p, 1), frames_of(p, 90)))),
                )
            } else {
                (None, None)
            };
            Command::AddAssetClips {
                asset_id: asset.into(),
                start: if rng.chance(30) {
                    None
                } else {
                    Some(frame_time(p, rng, total + 30))
                },
                track_id: if rng.chance(40) {
                    Some(rng.pick(&tracks).id.clone())
                } else {
                    None
                },
                source_in,
                source_out,
                mode: if rng.chance(30) {
                    PlaceMode::Insert
                } else {
                    PlaceMode::Overwrite
                },
            }
        }
        4 => Command::AddText {
            text: format!("Title {}", rng.range(0, 99)),
            start: frame_time(p, rng, total),
            duration: Some(frames_of(p, rng.range(1, 120))),
            track_id: None,
        },
        5..=8 => {
            let ids = some_clips(rng, p);
            let delta = frames_of(p, rng.range(-120, 240));
            let moves = ids
                .iter()
                .map(|id| {
                    let c = &p.clips[id];
                    let same_kind: Vec<&&Track> = tracks
                        .iter()
                        .filter(|t| t.kind == c.content.track_kind())
                        .collect();
                    let track = if rng.chance(25) {
                        rng.pick(&same_kind).id.clone()
                    } else {
                        c.track_id.clone()
                    };
                    ClipMove {
                        clip_id: id.clone(),
                        start: TimelineTime((c.start.0 + delta).max(0)),
                        track_id: track,
                    }
                })
                .collect();
            Command::MoveClips {
                moves,
                mode: if rng.chance(30) {
                    PlaceMode::Insert
                } else {
                    PlaceMode::Overwrite
                },
            }
        }
        9..=11 => Command::TrimClips {
            clip_ids: some_clips(rng, p),
            edge: if rng.chance(50) {
                Edge::Start
            } else {
                Edge::End
            },
            delta: frames_of(p, rng.range(-60, 60)) + rng.range(0, 3),
            ripple: rng.chance(50),
        },
        12 => Command::SlipClips {
            clip_ids: some_clips(rng, p),
            delta: frames_of(p, rng.range(-40, 40)),
        },
        13..=15 => {
            if rng.chance(50) {
                Command::SplitClips {
                    at: frame_time(p, rng, total),
                    clip_ids: None,
                }
            } else {
                let ids = some_clips(rng, p);
                let at = ids
                    .first()
                    .map(|id| p.clips[id].start + p.clips[id].duration / 2)
                    .unwrap_or(TimelineTime(0));
                Command::SplitClips {
                    at,
                    clip_ids: Some(ids),
                }
            }
        }
        16..=17 => Command::DeleteClips {
            clip_ids: some_clips(rng, p),
            ripple: rng.chance(60),
        },
        18 => {
            let s = rng.range(0, total);
            Command::RippleDeleteRange {
                start: TimelineTime(frames_of(p, s)),
                end: TimelineTime(frames_of(p, s + rng.range(0, 40))),
            }
        }
        19 => Command::CloseGap {
            track_id: rng.pick(&tracks).id.clone(),
            at: frame_time(p, rng, total),
        },
        20 => Command::DuplicateClips {
            clip_ids: some_clips(rng, p),
        },
        21 => Command::SetSpeed {
            clip_ids: some_clips(rng, p),
            speed: *rng.pick(&[0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.3, 4.0]),
            ripple: rng.chance(60),
        },
        22 => {
            let fields = match rng.range(0, 4) {
                0 => {
                    json!({"opacity": rng.range(0, 100) as f64 / 100.0, "scale": rng.range(10, 300) as f64 / 100.0})
                }
                1 => {
                    json!({"fade_in": frames_of(p, rng.range(0, 30)), "fade_out": frames_of(p, rng.range(0, 30))})
                }
                2 => json!({"gain_db": rng.range(-20, 12) as f64}),
                3 => json!({"enabled": rng.chance(50)}),
                _ => {
                    json!({"brightness": rng.range(50, 150) as f64 / 100.0, "x": rng.range(-50, 50) as f64 / 100.0})
                }
            };
            cmd(json!({"type": "update_clips", "clip_ids": some_clips(rng, p), "patch": fields}))
        }
        23 => match rng.range(0, 3) {
            0 => Command::LinkClips {
                clip_ids: some_clips(rng, p),
            },
            1 => Command::UnlinkClips {
                clip_ids: some_clips(rng, p),
            },
            2 => Command::GroupClips {
                clip_ids: some_clips(rng, p),
            },
            _ => Command::UngroupClips {
                clip_ids: some_clips(rng, p),
            },
        },
        24..=25 => {
            if !p.transitions.is_empty() && rng.chance(40) {
                let ids: Vec<&TransitionId> = p.transitions.keys().collect();
                let id = (*rng.pick(&ids)).clone();
                if rng.chance(50) {
                    Command::RemoveTransitions {
                        transition_ids: vec![id],
                    }
                } else {
                    Command::UpdateTransition {
                        transition_id: id,
                        kind: Some(*rng.pick(&[TransitionKind::Push, TransitionKind::DipToBlack])),
                        duration: Some(frames_of(p, rng.range(1, 60))),
                    }
                }
            } else {
                Command::AddTransitions {
                    left_clip_ids: some_clips(rng, p),
                    kind: *rng.pick(&[
                        TransitionKind::CrossDissolve,
                        TransitionKind::DipToBlack,
                        TransitionKind::Slide,
                        TransitionKind::Push,
                    ]),
                    duration: frames_of(p, rng.range(1, 60)),
                }
            }
        }
        26 => {
            let t = rng.pick(&tracks);
            match rng.range(0, 9) {
                0 => Command::AddTrack {
                    kind: *rng.pick(&[TrackKind::Video, TrackKind::Audio, TrackKind::Caption]),
                    name: None,
                },
                1 => Command::RemoveTrack {
                    track_id: t.id.clone(),
                },
                2 => Command::MoveTrack {
                    track_id: t.id.clone(),
                    ordinal: rng.range(0, 2) as usize,
                },
                3 | 4 => {
                    cmd(json!({"type": "update_track", "track_id": t.id, "locked": !t.locked}))
                }
                5 => cmd(
                    json!({"type": "update_track", "track_id": t.id, "muted": !t.muted, "solo": rng.chance(20)}),
                ),
                6 => cmd(
                    json!({"type": "update_track", "track_id": t.id, "hidden": !t.hidden, "gain_db": rng.range(-12, 6) as f64}),
                ),
                _ => {
                    // keep the session lively: unlock everything that is locked
                    match p.tracks.iter().find(|t| t.locked) {
                        Some(l) => {
                            cmd(json!({"type": "update_track", "track_id": l.id, "locked": false}))
                        }
                        None => Command::AddMarker {
                            time: frame_time(p, rng, total),
                            label: "m".into(),
                            color: None,
                        },
                    }
                }
            }
        }
        27 => {
            if !p.markers.is_empty() && rng.chance(40) {
                Command::RemoveMarker {
                    marker_id: rng.pick(&p.markers).id.clone(),
                }
            } else {
                Command::AddMarker {
                    time: frame_time(p, rng, total),
                    label: "m".into(),
                    color: None,
                }
            }
        }
        28 => {
            let n = rng.range(1, 4);
            let mut t = rng.range(0, total);
            let mut cues = Vec::new();
            for i in 0..n {
                let d = rng.range(1, 60);
                cues.push(CueDraft {
                    start: TimelineTime(frames_of(p, t)),
                    duration: frames_of(p, d),
                    text: format!("caption {i}"),
                    speaker: None,
                    source: None,
                });
                t += rng.range(0, 80);
            }
            Command::AddCaptions {
                cues,
                track_id: None,
            }
        }
        29 => {
            // transcript-style cut inside a random media clip
            let media: Vec<&Clip> = p
                .clips
                .values()
                .filter(|c| c.content.is_timed_media())
                .collect();
            if media.is_empty() {
                return Command::AddMarker {
                    time: TimelineTime(0),
                    label: "m".into(),
                    color: None,
                };
            }
            let n = rng.range(1, 3);
            let cuts = (0..n)
                .map(|_| {
                    let c = *rng.pick(&media);
                    let span = c.source_duration();
                    let a = c.source_in.0 + rng.range(0, span - 1);
                    let b = (a + rng.range(1, span / 2 + frames_of(p, 2)))
                        .min(c.source_out().0 + frames_of(p, 3));
                    SourceCut {
                        clip_id: c.id.clone(),
                        source_start: SourceTime(a),
                        source_end: SourceTime(b),
                        text: "um".into(),
                    }
                })
                .collect();
            Command::RippleDeleteSource {
                cuts,
                reason: *rng.pick(&[
                    RemovalReason::Manual,
                    RemovalReason::Filler,
                    RemovalReason::Silence,
                ]),
            }
        }
        30 => Command::HealCuts {
            left_clip_ids: some_clips(rng, p),
        },
        _ => {
            if rng.chance(35) {
                // transcript-side edits (the session's Env carries a transcript for `vid`)
                match rng.range(0, 3) {
                    0 => Command::GenerateCaptions {
                        options: cutline_core::captions::CaptionOptions {
                            max_chars_per_line: rng.range(8, 40) as u32,
                            max_lines: rng.range(1, 3) as u32,
                            speaker_labels: rng.chance(50),
                            ..Default::default()
                        },
                    },
                    1 => Command::CorrectWord {
                        asset_id: "vid".into(),
                        word_index: rng.range(0, 130) as u32,
                        text: if rng.chance(75) {
                            Some(format!("fix{}", rng.range(0, 9)))
                        } else {
                            None
                        },
                    },
                    2 => Command::RenameSpeaker {
                        asset_id: "vid".into(),
                        speaker: rng.pick(&["1", "2"]).to_string(),
                        name: if rng.chance(75) {
                            Some(format!("Name {}", rng.range(0, 9)))
                        } else {
                            None
                        },
                    },
                    _ => Command::SetTranscriptEditing {
                        enabled: rng.chance(50),
                    },
                }
            } else if rng.chance(15) {
                Command::UpdateSettings {
                    width: None,
                    height: None,
                    fps: Some(*rng.pick(&[
                        FrameRate::FPS_24,
                        FrameRate::FPS_25,
                        FrameRate::FPS_30,
                        FrameRate::FPS_29_97,
                        FrameRate::FPS_60,
                    ])),
                    background: None,
                    caption_style: None,
                }
            } else {
                // a two-step transaction
                let a = random_command(rng, p);
                Command::Batch {
                    commands: vec![
                        a,
                        Command::AddMarker {
                            time: frame_time(p, rng, total),
                            label: "batch".into(),
                            color: None,
                        },
                    ],
                    label: None,
                }
            }
        }
    }
}

fn check_document(p: &Project) {
    validate::validate(p).unwrap_or_else(|e| panic!("invalid document: {e}"));
    let fps = p.fps();
    for t in &p.tracks {
        let clips = p.track_clips(&t.id);
        for w in clips.windows(2) {
            assert!(w[1].start >= w[0].end(), "overlap on {}", t.name);
        }
        for c in clips {
            assert_eq!(c.content.track_kind(), t.kind);
        }
    }
    for c in p.clips.values() {
        assert!(c.start.0 >= 0 && c.duration > 0);
        assert!(
            fps.is_aligned(c.start.0) && fps.is_aligned(c.duration),
            "clip {} off grid",
            c.id
        );
        assert!(c.fade_in >= 0 && c.fade_out >= 0 && c.fade_in + c.fade_out <= c.duration);
        if let Some(l) = &c.link_id {
            assert!(
                p.clips
                    .values()
                    .filter(|o| o.link_id.as_ref() == Some(l))
                    .count()
                    >= 2,
                "dangling link {l}"
            );
        }
        if let Some(g) = &c.group_id {
            assert!(
                p.clips
                    .values()
                    .filter(|o| o.group_id.as_ref() == Some(g))
                    .count()
                    >= 2,
                "dangling group {g}"
            );
        }
        if c.content.is_timed_media() {
            assert!(c.source_in.0 >= 0);
        }
    }
    for t in p.transitions.values() {
        let (l, r) = (&p.clips[&t.left], &p.clips[&t.right]);
        assert_eq!(l.end(), r.start);
        assert_eq!(l.track_id, r.track_id);
        assert!(t.duration <= l.duration.min(r.duration));
    }
    // ids are unique across everything that was ever generated
    assert!(p.clips.keys().all(|k| k.starts_with('c')));
    // layers resolve for every clip and never start after they end
    let layers = resolve_layers(p);
    assert_eq!(layers.len(), p.clips.len());
    for l in &layers {
        assert!(l.end > l.start);
        for r in [&l.fade_in, &l.fade_out].into_iter().flatten() {
            assert!(r.end > r.start, "degenerate ramp on {}", l.clip_id);
        }
    }
}

fn run_session(seed: u64, target_commits: usize, max_attempts: usize) -> (usize, usize) {
    let mut rng = Rng(seed);
    // starting document: a few clips so early commands have something to chew on
    let (p, _) = add(&project(), "vid", Some(0));
    let (p, _) = add_range(&p, "vid2", None, Some(100), Some(400));
    let (p, _) = add_range(&p, "mute", None, Some(0), Some(200));
    let a2 = track_id(&p, "A2");
    let p = run(
        &p,
        Command::AddAssetClips {
            asset_id: "aud".into(),
            start: Some(tl(50)),
            track_id: Some(a2),
            source_in: None,
            source_out: Some(src(900)),
            mode: PlaceMode::Overwrite,
        },
    );
    let start = p.clone();
    let mut s = Session::new(p, History::default());
    // 120 words over the first minute of `vid`, two speakers, a few fillers
    let texts: Vec<String> = (0..120)
        .map(|i| {
            if i % 11 == 5 {
                "um".to_string()
            } else {
                format!("word{i}{}", if i % 9 == 8 { "." } else { "" })
            }
        })
        .collect();
    let words: Vec<(&str, i64, i64, &str)> = texts
        .iter()
        .enumerate()
        .map(|(i, t)| {
            (
                t.as_str(),
                i as i64 * 480,
                i as i64 * 480 + 400,
                if (i / 13) % 2 == 0 { "1" } else { "2" },
            )
        })
        .collect();
    let env = env_with(vec![transcript("vid", &words)]);
    let (mut commits, mut attempts, mut rejected) = (0usize, 0usize, 0usize);
    let mut kinds_committed = std::collections::BTreeMap::<String, usize>::new();

    while commits < target_commits && attempts < max_attempts {
        attempts += 1;
        let c = random_command(&mut rng, &s.project);
        let before = s.project.clone();
        let history_len = s.history.undo.len();
        match s.execute(before.revision, &c, &env, attempts as i64) {
            Ok(change) => {
                commits += 1;
                *kinds_committed
                    .entry(
                        serde_json::to_value(&c).unwrap()["type"]
                            .as_str()
                            .unwrap()
                            .to_string(),
                    )
                    .or_default() += 1;
                check_document(&s.project);
                assert_eq!(s.project.revision, before.revision + 1);
                assert_eq!(s.history.undo.len(), history_len + 1);
                // the payload reproduces the document
                let mut replay = before.clone();
                change.patch.apply(&mut replay);
                assert!(
                    same_doc(&replay, &s.project),
                    "seed {seed} step {attempts}: patch does not reproduce {c:?}"
                );
                assert_eq!(s.layers(), resolve_layers(&s.project));
                for id in &change.created {
                    assert!(
                        s.project.clips.contains_key(id),
                        "seed {seed}: created id {id} missing after {c:?}"
                    );
                }
                assert!(s.project.next_id >= before.next_id);
                // the derived transcript view is always consistent with the document
                let view = cutline_core::mapping::timeline_transcript(&s.project, &env.transcripts);
                for seg in &view.segments {
                    let clip = &s.project.clips[&seg.clip_id];
                    assert_eq!((seg.start, seg.end), (clip.start, clip.end()));
                    for w in &seg.words {
                        assert!(
                            w.start >= seg.start && w.end <= seg.end && w.start <= w.end,
                            "seed {seed}: word {} escapes its clip",
                            w.index
                        );
                    }
                    assert!(seg
                        .words
                        .windows(2)
                        .all(|p| p[0].index < p[1].index && p[0].start <= p[1].start));
                }
            }
            Err(e) => {
                rejected += 1;
                assert_ne!(
                    e.code,
                    ErrorCode::InvariantViolation,
                    "seed {seed} step {attempts}: {c:?} hit an internal invariant: {}",
                    e.message
                );
                assert_ne!(e.code, ErrorCode::StaleRevision);
                assert!(!e.message.is_empty());
                assert_eq!(
                    s.project, before,
                    "seed {seed}: rejected command mutated the document"
                );
                assert_eq!(s.history.undo.len(), history_len);
            }
        }
    }
    assert!(
        commits >= target_commits.min(60),
        "seed {seed}: only {commits} commands committed in {attempts} attempts"
    );
    assert!(
        kinds_committed.len() >= 12,
        "seed {seed}: too little variety: {kinds_committed:?}"
    );
    if std::env::var("CUTLINE_SOAK_VERBOSE").is_ok() {
        println!("seed {seed}: {commits} commits, {rejected} rejected: {kinds_committed:?}");
    }
    assert!(
        commits <= HISTORY_MAX_ENTRIES,
        "keep the whole session undoable"
    );

    // undo everything → the starting document
    let end = s.project.clone();
    let mut undone = 0;
    while s.history_state().can_undo {
        let rev = s.project.revision;
        s.undo(rev, 0)
            .unwrap_or_else(|e| panic!("seed {seed}: undo {undone} failed: {e:?}"));
        check_document(&s.project);
        undone += 1;
    }
    assert_eq!(undone, commits);
    assert!(
        same_doc(&s.project, &start),
        "seed {seed}: undoing everything did not restore the start"
    );
    // redo everything → the final document, exactly
    while s.history_state().can_redo {
        let rev = s.project.revision;
        s.redo(rev, 0)
            .unwrap_or_else(|e| panic!("seed {seed}: redo failed: {e:?}"));
    }
    assert!(
        same_doc(&s.project, &end),
        "seed {seed}: redoing everything did not reproduce the end state"
    );
    assert_eq!(s.layers(), resolve_layers(&s.project));
    (commits, rejected)
}

#[test]
fn random_editing_sessions_keep_every_invariant() {
    let mut total = 0;
    for seed in [1, 2, 3, 0xC0FFEE, 0xDEADBEEF, 20261110] {
        let (commits, _rejected) = run_session(seed, 280, 4_000);
        total += commits;
    }
    assert!(
        total >= 6 * 200,
        "sessions should mostly reach their target ({total} commits)"
    );
}

#[test]
fn sessions_are_deterministic() {
    // the same seed must produce byte-identical documents
    let doc = |seed| {
        let mut rng = Rng(seed);
        let mut s = Session::new(add(&project(), "vid", Some(0)).0, History::default());
        for i in 0..400 {
            let c = random_command(&mut rng, &s.project);
            let rev = s.project.revision;
            let _ = s.execute(rev, &c, &Env::default(), i);
        }
        serde_json::to_string(&s.project).unwrap()
    };
    assert_eq!(doc(77), doc(77));
    assert_ne!(doc(77), doc(78));
}

/// Longer hunt for rare interleavings: `cargo test -p cutline-core --test invariants -- --ignored`
/// (`CUTLINE_SOAK_SEEDS=N` sets the number of sessions, default 200).
#[test]
#[ignore = "long soak test; run explicitly with --ignored"]
fn soak_many_random_sessions() {
    let n: u64 = std::env::var("CUTLINE_SOAK_SEEDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(200);
    for seed in 1_000..1_000 + n {
        run_session(seed, 280, 3_000);
    }
}
